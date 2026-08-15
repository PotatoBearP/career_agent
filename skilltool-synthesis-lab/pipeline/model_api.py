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
    timeout_seconds: int = 120

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
            timeout_seconds=int(value.get("timeout_seconds", 120)),
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
        decoder = json.JSONDecoder()
        for index, char in enumerate(cleaned):
            if char not in "[{":
                continue
            try:
                value, _ = decoder.raw_decode(cleaned[index:])
                return value
            except json.JSONDecodeError:
                continue
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

    @staticmethod
    def _default_transport(request: urllib.request.Request, timeout: int) -> bytes:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()

    def complete_json(self, *, system: str, user: str) -> Any:
        payload = {
            "model": self.config.model,
            "temperature": self.config.temperature,
            "max_tokens": self.config.max_tokens,
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
        try:
            response = json.loads(raw.decode("utf-8"))
            content = response["choices"][0]["message"]["content"]
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
        return extract_json(content)
