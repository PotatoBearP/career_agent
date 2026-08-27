from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable


class ModelAPIError(RuntimeError):
    pass


@dataclass(frozen=True)
class ModelConfig:
    base_url: str
    model: str
    api_key: str = ""
    temperature: float = 0.2
    max_tokens: int = 6000
    timeout_seconds: int = 300

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ModelConfig":
        api_key = str(value.get("api_key") or "").strip()
        api_key_env = str(value.get("api_key_env") or "").strip()
        if not api_key and api_key_env:
            api_key = os.environ.get(api_key_env, "").strip()
        return cls(
            base_url=str(value.get("base_url") or "").strip(),
            model=str(value.get("model") or "").strip(),
            api_key=api_key,
            temperature=float(value.get("temperature", 0.2)),
            max_tokens=int(value.get("max_tokens", 6000)),
            timeout_seconds=int(value.get("timeout_seconds", 300)),
        )

    def validate(self) -> None:
        if not self.base_url:
            raise ModelAPIError("model base_url is required")
        if not self.model:
            raise ModelAPIError("model name is required")


def chat_completions_url(base_url: str) -> str:
    normalized = base_url.strip().rstrip("/")
    if re.search(r"/chat/completions$", normalized, re.IGNORECASE):
        return normalized
    if re.search(r"/v1$", normalized, re.IGNORECASE):
        return f"{normalized}/chat/completions"
    return f"{normalized}/v1/chat/completions"


def extract_json(text: str) -> Any:
    cleaned = text.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", cleaned, re.DOTALL)
    if fenced:
        cleaned = fenced.group(1).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        indexes = [index for index in (cleaned.find("{"), cleaned.find("[")) if index >= 0]
        if indexes:
            try:
                value, _ = json.JSONDecoder().raw_decode(cleaned[min(indexes):])
                return value
            except json.JSONDecodeError:
                pass
    raise ModelAPIError("model response did not contain valid JSON")


class OpenAICompatibleModel:
    def __init__(
        self,
        config: ModelConfig,
        *,
        transport: Callable[[urllib.request.Request, int], bytes] | None = None,
    ) -> None:
        config.validate()
        self.config = config
        self.transport = transport or self._default_transport
        self.last_trace: dict[str, Any] = {}
        self.max_tokens_override: int | None = None

    @staticmethod
    def _default_transport(request: urllib.request.Request, timeout: int) -> bytes:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()

    def complete_json(self, *, system: str, user: str) -> Any:
        payload = {
            "model": self.config.model,
            "temperature": self.config.temperature,
            "max_tokens": self.max_tokens_override or self.config.max_tokens,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        headers = {"Content-Type": "application/json"}
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"
        request = urllib.request.Request(
            chat_completions_url(self.config.base_url),
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            raw = self.transport(request, self.config.timeout_seconds)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise ModelAPIError(f"model API returned HTTP {error.code}: {detail[:1000]}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise ModelAPIError(f"model API request failed: {error}") from error
        raw_text = raw.decode("utf-8", errors="replace")
        self.last_trace = {
            "provider": "openai_compatible",
            "endpoint": chat_completions_url(self.config.base_url),
            "request": payload,
            "raw_response": raw_text,
        }
        try:
            response = json.loads(raw_text)
            choice = response["choices"][0]
            content = choice["message"]["content"]
            if isinstance(content, list):
                content = "".join(
                    str(part.get("text", ""))
                    for part in content
                    if isinstance(part, dict)
                )
            if not isinstance(content, str):
                raise TypeError("message content is not text")
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
            raise ModelAPIError("model API returned an unsupported response shape") from error
        self.last_trace["finish_reason"] = choice.get("finish_reason")
        self.last_trace["response_content"] = content
        if choice.get("finish_reason") == "length":
            raise ModelAPIError("model response was truncated because max_tokens was reached")
        try:
            return extract_json(content)
        except ModelAPIError as original_error:
            repair_payload = {
                "model": self.config.model,
                "temperature": 0,
                "max_tokens": self.max_tokens_override or self.config.max_tokens,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "Repair the supplied malformed JSON. Preserve all fields and values, "
                            "change only JSON syntax, and return exactly one valid JSON value with "
                            "no markdown fence or commentary."
                        ),
                    },
                    {"role": "user", "content": content},
                ],
            }
            repair_request = urllib.request.Request(
                chat_completions_url(self.config.base_url),
                data=json.dumps(repair_payload, ensure_ascii=False).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            try:
                repair_raw = self.transport(repair_request, self.config.timeout_seconds)
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", errors="replace")
                raise ModelAPIError(
                    f"JSON repair request returned HTTP {error.code}: {detail[:1000]}"
                ) from original_error
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                raise ModelAPIError(f"JSON repair request failed: {error}") from original_error
            repair_raw_text = repair_raw.decode("utf-8", errors="replace")
            try:
                repair_response = json.loads(repair_raw_text)
                repair_choice = repair_response["choices"][0]
                repaired_content = repair_choice["message"]["content"]
                if isinstance(repaired_content, list):
                    repaired_content = "".join(
                        str(part.get("text", ""))
                        for part in repaired_content
                        if isinstance(part, dict)
                    )
                if not isinstance(repaired_content, str):
                    raise TypeError("repair message content is not text")
            except (KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
                raise ModelAPIError("JSON repair returned an unsupported response shape") from error
            self.last_trace["json_repair"] = {
                "request": repair_payload,
                "raw_response": repair_raw_text,
                "finish_reason": repair_choice.get("finish_reason"),
                "response_content": repaired_content,
            }
            if repair_choice.get("finish_reason") == "length":
                raise ModelAPIError("JSON repair response was truncated") from original_error
            try:
                return extract_json(repaired_content)
            except ModelAPIError as repair_error:
                raise ModelAPIError("model response remained invalid after one JSON repair") from repair_error
