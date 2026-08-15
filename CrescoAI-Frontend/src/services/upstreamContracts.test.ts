import { describe, expect, it } from 'vitest';
import { clearUploadedAssetPresentationCache, rememberUploadedAssetPresentation } from './uploadedAssetPresentationCache';
import {
  normalizeArtifactRecord,
  normalizeProfileSuggestion,
  sanitizeProfileRecord,
  normalizeMessageStreamEvent,
  normalizeThreadMessage,
  normalizeThreadSummary,
} from './upstreamContracts';

describe('sanitizeProfileRecord', () => {
  it('normalizes the sample profile envelope without leaking fixture metadata', () => {
    const profile = sanitizeProfileRecord({
      _meta: {
        personaId: 'freelancer-indie-developer',
        careerStage: 'mid',
      },
      profile: {
        displayName: '苏远',
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        currentRole: '独立开发者 / 自由职业全栈工程师',
        employmentStatus: '自由职业',
        targetIndustries: ['开发者工具', 'SaaS'],
        workPreferences: ['远程优先', '自主决策空间'],
        learningPreferences: ['项目驱动', '英文文档'],
        keyStrengths: ['快速交付'],
        portfolio_links: ['https://example.com'],
      },
    });

    expect(profile).toMatchObject({
      basicInfo: {
        fullName: '苏远',
        currentCity: 'Asia/Shanghai',
      },
      careerProfile: {
        currentRole: '独立开发者 / 自由职业全栈工程师',
        employmentStatus: '自由职业',
        skills: ['快速交付'],
      },
      intentConstraints: {
        targetIndustry: '开发者工具',
        targetIndustries: ['开发者工具', 'SaaS'],
        workPreferences: ['远程优先', '自主决策空间'],
        learningPreferences: ['项目驱动', '英文文档'],
      },
      artifacts: {
        portfolioLinks: ['https://example.com'],
      },
    });
    expect(profile).not.toHaveProperty('_meta');
    expect(profile.intentConstraints.expectedSalary).toBe('');
  });

  it('migrates legacy snake_case fields and safely fills missing arrays', () => {
    const profile = sanitizeProfileRecord({
      display_name: '苏远',
      target_role: '全职独立开发者',
      key_strengths: ['快速交付', '快速交付', '  '],
    });

    expect(profile.basicInfo.fullName).toBe('苏远');
    expect(profile.intentConstraints.targetRole).toBe('全职独立开发者');
    expect(profile.careerProfile.skills).toEqual(['快速交付']);
    expect(profile.artifacts.portfolioLinks).toEqual([]);
  });
});

describe('uploaded asset presentation cache integration', () => {
  it('prefers remembered original file names over sanitized backend titles for the current session', () => {
    clearUploadedAssetPresentationCache();
    rememberUploadedAssetPresentation({
      assetId: 'asset-cache-001',
      kind: 'file',
      url: '/api/career-agent/threads/12/files/1777216174484-b872f9fa-ffe0-4769-badb-b8b91812b35c.pptx',
      title: '___________________v1.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      sizeBytes: 4,
      createdAt: '2026-04-26T15:09:34.485Z',
      storagePath: '/api/career-agent/threads/12/files/1777216174484-b872f9fa-ffe0-4769-badb-b8b91812b35c.pptx',
      storedFileName: '1777216174484-b872f9fa-ffe0-4769-badb-b8b91812b35c.pptx',
      originalName: '___________________v1.pptx',
    }, '测试（终版）+v1.pptx');

    const message = normalizeThreadMessage({
      id: 'message-cache-001',
      role: 'user',
      content: '请看附件。',
      attachments: [
        {
          id: 'asset-cache-001',
          kind: 'file',
          url: '/api/career-agent/threads/12/files/1777216174484-b872f9fa-ffe0-4769-badb-b8b91812b35c.pptx',
          title: '___________________v1.pptx',
          mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        },
      ],
      created_at: '2026-04-26T10:06:00.000Z',
    }, '12');

    expect(message.files?.[0]?.name).toBe('测试（终版）+v1.pptx');
    clearUploadedAssetPresentationCache();
  });
});

describe('normalizeArtifactRecord', () => {
  it('maps snake_case fields and queued status into the frontend artifact shape', () => {
    const artifact = normalizeArtifactRecord({
      id: 'artifact-weekly-plan',
      type: 'weekly-plan',
      title: 'Weekly Plan',
      status: 'queued',
      render_mode: 'html',
      revision: 4,
      updated_at: '2026-04-08T05:00:00Z',
      summary: 'Queued for refresh.',
      payload: {
        html: '<div>hello</div>',
      },
    });

    expect(artifact).toEqual({
      id: 'artifact-weekly-plan',
      type: 'weekly-plan',
      title: 'Weekly Plan',
      status: 'loading',
      renderMode: 'html',
      revision: 4,
      updatedAt: '2026-04-08T05:00:00Z',
      summary: 'Queued for refresh.',
      payload: {
        html: '<div>hello</div>',
      },
    });
  });

  it('preserves trusted url render mode payloads for application-host artifacts', () => {
    const artifact = normalizeArtifactRecord({
      id: 'artifact-career-roadmap',
      type: 'career-roadmap',
      title: 'Career Roadmap Lab',
      status: 'ready',
      render_mode: 'url',
      revision: 2,
      updated_at: '2026-04-10T03:00:00Z',
      summary: 'Hosted via application URL.',
      payload: {
        url: '/mock-node-canvas/index.html',
      },
    });

    expect(artifact.renderMode).toBe('url');
    if (artifact.renderMode !== 'url') {
      throw new Error('expected url artifact');
    }

    expect(artifact.payload.url).toBe('/mock-node-canvas/index.html');
  });

  it('provides safe empty html payloads when html mode arrives without markup', () => {
    const artifact = normalizeArtifactRecord({
      id: 'artifact-empty-html',
      type: 'weekly-plan',
      title: 'Empty HTML',
      status: 'ready',
      render_mode: 'html',
      revision: 1,
      summary: 'Missing html markup.',
      payload: {},
    });

    expect(artifact.renderMode).toBe('html');
    if (artifact.renderMode !== 'html') {
      throw new Error('expected html artifact');
    }

    expect(artifact.payload.html).toBe('');
  });
});

describe('normalizeThreadSummary', () => {
  it('normalizes the current server thread list shape into frontend strings', () => {
    const thread = normalizeThreadSummary({
      id: 1,
      userId: 1,
      title: '问好',
      preview: '你好',
      updatedAt: 1776644879000,
      createdAt: 1776644820000,
    });

    expect(thread).toEqual({
      id: '1',
      title: '问好',
      preview: '你好',
      updatedAt: new Date(1776644879000).toISOString(),
      status: 'active',
    });
  });
});

describe('normalizeThreadMessage', () => {
  it('extracts inline think blocks and maps agent metadata into the frontend message shape', () => {
    const message = normalizeThreadMessage({
      id: 'message-001',
      role: 'assistant',
      content: '<think>先比较路径，再决定输出什么。</think>\n\n给你一版更聚焦的建议。',
      agent_name: '方向助手',
      agent_accent: 'blue',
      created_at: '2026-04-10T08:00:00Z',
    }, 'thread-001');

    expect(message.threadId).toBe('thread-001');
    expect(message.content).toBe('给你一版更聚焦的建议。');
    expect(message.reasoning).toBe('先比较路径，再决定输出什么。');
    expect(message.agentName).toBe('方向助手');
    expect(message.agentAccent).toBe('blue');
  });

  it('normalizes assistant message actions into frontend canvas actions', () => {
    const message = normalizeThreadMessage({
      id: 'message-003',
      role: 'assistant',
      content: '可以打开一个模拟面试画布。',
      actions: [
        {
          id: 'action-open-interview',
          kind: 'open_artifact',
          label: '打开模拟面试',
          artifact_id: 'artifact-mock-interview',
          view_mode: 'immersive',
        },
      ],
      created_at: '2026-04-10T08:02:00Z',
    }, 'thread-001');

    expect(message.actions).toEqual([
      {
        id: 'action-open-interview',
        kind: 'open-artifact',
        label: '打开模拟面试',
        artifactId: 'artifact-mock-interview',
        viewMode: 'immersive',
      },
    ]);
  });

  it('drops unsupported assistant message actions from upstream payloads', () => {
    const message = normalizeThreadMessage({
      id: 'message-004',
      role: 'assistant',
      content: '这里混入了暂不支持的动作。',
      actions: [
        {
          id: 'action-unsupported',
          kind: 'download_artifact',
          label: '下载',
          artifact_id: 'artifact-mock-interview',
        },
        {
          id: 'action-invalid-view-mode',
          kind: 'open_artifact',
          label: '打开',
          artifact_id: 'artifact-mock-interview',
          view_mode: 'fullscreen',
        },
      ],
      created_at: '2026-04-10T08:03:00Z',
    }, 'thread-001');

    expect(message.actions).toEqual([
      {
        id: 'action-invalid-view-mode',
        kind: 'open-artifact',
        label: '打开',
        artifactId: 'artifact-mock-interview',
      },
    ]);
  });

  it('does not normalize actions from non-assistant messages', () => {
    const message = normalizeThreadMessage({
      id: 'message-005',
      role: 'user',
      content: '这条用户消息不应该打开画布。',
      actions: [
        {
          id: 'action-open-interview',
          kind: 'open_artifact',
          label: '打开模拟面试',
          artifact_id: 'artifact-mock-interview',
          view_mode: 'immersive',
        },
      ],
      created_at: '2026-04-10T08:04:00Z',
    }, 'thread-001');

    expect(message.actions).toBeUndefined();
  });

  it('does not strip literal think tags from non-assistant messages', () => {
    const message = normalizeThreadMessage({
      id: 'message-002',
      role: 'user',
      content: '请保留这段字面量：<think>debug</think>',
      created_at: '2026-04-10T08:01:00Z',
    }, 'thread-001');

    expect(message.content).toBe('请保留这段字面量：<think>debug</think>');
    expect(message.reasoning).toBeNull();
  });

  it('normalizes supported image and video media while dropping unsafe media URLs', () => {
    const message = normalizeThreadMessage({
      id: 'message-006',
      role: 'assistant',
      content: '这里带有多模态附件。',
      media: [
        {
          id: 'image-001',
          kind: 'image',
          url: '/mock-media/test_image.png',
          title: '测试图片',
          caption: '用于验证图片显示。',
          mime_type: 'image/png',
        },
        {
          id: 'video-001',
          type: 'video',
          src: 'FILE:///tmp/test_video.mp4',
          title: '不应展示的本地视频',
        },
        {
          id: 'image-unsafe-script',
          type: 'image',
          src: 'javascript:alert(1)',
        },
        {
          id: 'image-unsafe-data',
          type: 'image',
          src: 'data:image/svg+xml,<svg></svg>',
        },
        {
          id: 'image-unsafe-protocol-relative',
          type: 'image',
          src: '//example.com/image.png',
        },
        {
          id: 'video-002',
          type: 'video',
          src: '/mock-media/test_video.mp4',
          poster_url: '/mock-media/test_image.png',
          mimeType: 'video/mp4',
        },
      ],
      created_at: '2026-04-14T03:20:00Z',
    }, 'thread-006');

    expect(message.media).toEqual([
      {
        id: 'image-001',
        kind: 'image',
        url: '/mock-media/test_image.png',
        title: '测试图片',
        caption: '用于验证图片显示。',
        alt: undefined,
        mimeType: 'image/png',
        posterUrl: undefined,
      },
      {
        id: 'video-002',
        kind: 'video',
        url: '/mock-media/test_video.mp4',
        title: undefined,
        caption: undefined,
        alt: undefined,
        mimeType: 'video/mp4',
        posterUrl: '/mock-media/test_image.png',
      },
    ]);
  });

  it('merges media and attachments sources for multimodal messages', () => {
    const message = normalizeThreadMessage({
      id: 'message-007',
      role: 'assistant',
      content: '这里同时带有 media 和 attachments。',
      media: [
        {
          id: 'image-from-media',
          kind: 'image',
          url: '/mock-media/test_image.png',
        },
      ],
      attachments: [
        {
          id: 'video-from-attachments',
          kind: 'video',
          url: 'https://example.com/test_video.mp4',
        },
      ],
      created_at: '2026-04-14T03:30:00Z',
    }, 'thread-007');

    expect(message.media?.map((media) => media.id)).toEqual([
      'image-from-media',
      'video-from-attachments',
    ]);
  });

  it('deduplicates repeated assets when the backend mirrors the same attachment in media and attachments', () => {
    const message = normalizeThreadMessage({
      id: 'message-dup',
      role: 'user',
      content: '重复附件',
      media: [
        {
          id: 'image-dup',
          kind: 'image',
          url: '/uploads/image-dup.png',
          title: '图片',
        },
      ],
      attachments: [
        {
          id: 'image-dup',
          kind: 'image',
          url: '/uploads/image-dup.png',
          title: '图片',
        },
        {
          id: 'file-dup',
          kind: 'file',
          stored_file_name: '1714123456789-uuid.docx',
          original_name: 'resume.docx',
          mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size_bytes: 245991,
        },
        {
          id: 'file-dup',
          kind: 'file',
          stored_file_name: '1714123456789-uuid.docx',
          original_name: 'resume.docx',
          mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size_bytes: 245991,
        },
      ],
      created_at: '2026-04-26T10:06:00.000Z',
    }, '12');

    expect(message.media).toEqual([
      {
        id: 'image-dup',
        kind: 'image',
        url: '/uploads/image-dup.png',
        title: '图片',
        caption: undefined,
        alt: undefined,
        mimeType: undefined,
        posterUrl: undefined,
      },
    ]);
    expect(message.files).toEqual([
      {
        id: 'file-dup',
        name: 'resume.docx',
        url: '/api/career-agent/threads/12/files/1714123456789-uuid.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: 245991,
      },
    ]);
  });

  it('normalizes backend file attachments into frontend file attachments', () => {
    const message = normalizeThreadMessage({
      id: 'message-file',
      role: 'user',
      content: '请看附件。',
      attachments: [
        {
          id: 'asset-file-001',
          kind: 'file',
          url: '/api/career-agent/threads/12/files/resume.pdf',
          title: 'resume.pdf',
          mime_type: 'application/pdf',
          size_bytes: 245991,
        },
      ],
      created_at: '2026-04-26T10:06:00.000Z',
    }, '12');

    expect(message.media).toBeUndefined();
    expect(message.files).toEqual([
      {
        id: 'asset-file-001',
        name: 'resume.pdf',
        url: '/api/career-agent/threads/12/files/resume.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 245991,
      },
    ]);
  });

  it('normalizes numeric backend file attachment ids safely', () => {
    const message = normalizeThreadMessage({
      id: 'message-file',
      role: 'user',
      content: '请看附件。',
      attachments: [
        {
          id: 123,
          kind: 'file',
          url: '/api/career-agent/threads/12/files/resume.pdf',
          title: 'resume.pdf',
        },
      ],
      created_at: '2026-04-26T10:06:00.000Z',
    }, '12');

    expect(message.files?.[0]?.id).toBe('123');
  });

  it('uses original_name and stored_file_name when the backend omits title and direct url', () => {
    const message = normalizeThreadMessage({
      id: 'message-file-fallback',
      role: 'user',
      content: '请看附件。',
      attachments: [
        {
          id: 'asset-file-002',
          kind: 'file',
          stored_file_name: '1714123456789-uuid.pdf',
          original_name: 'resume.pdf',
          mime_type: 'application/pdf',
        },
      ],
      created_at: '2026-04-26T10:06:00.000Z',
    }, '12');

    expect(message.files).toEqual([
      {
        id: 'asset-file-002',
        name: 'resume.pdf',
        url: '/api/career-agent/threads/12/files/1714123456789-uuid.pdf',
        mimeType: 'application/pdf',
        sizeBytes: undefined,
      },
    ]);
  });

  it('normalizes the current server message list shape into frontend strings', () => {
    const message = normalizeThreadMessage({
      id: 2,
      conversationId: 1,
      role: 'assistant',
      kind: 'markdown',
      content: '你好，有什么我可以帮你的',
      reasoning: '用户打招呼',
      agentId: '1',
      agentName: '助手',
      actions: null,
      media: null,
      createdAt: 1776645161000,
    }, '1');

    expect(message).toMatchObject({
      id: '2',
      threadId: '1',
      role: 'assistant',
      kind: 'markdown',
      content: '你好，有什么我可以帮你的',
      reasoning: '用户打招呼',
      agentId: '1',
      agentName: '助手',
      createdAt: new Date(1776645161000).toISOString(),
    });
  });

  it('preserves CC transcript metadata from projected backend messages', () => {
    const message = normalizeThreadMessage({
      id: 'msg-assistant-1',
      uuid: 'uuid-assistant-1',
      parent_uuid: 'uuid-user-1',
      session_id: 'session-1',
      thread_id: 'session-1',
      role: 'assistant',
      kind: 'markdown',
      content: 'Done.',
      reasoning: '[工具调用]\n正在调用工具。',
      model: 'claude-test',
      usage: { input_tokens: 7, output_tokens: 11 },
      stop_reason: 'end_turn',
      blocks: [{ type: 'text', text: 'Done.' }],
      raw: { source: 'cc-transcript' },
      created_at: '2026-04-26T10:06:00.000Z',
    }, 'fallback-thread');

    expect(message).toMatchObject({
      id: 'msg-assistant-1',
      uuid: 'uuid-assistant-1',
      parentUuid: 'uuid-user-1',
      sessionId: 'session-1',
      model: 'claude-test',
      usage: { input_tokens: 7, output_tokens: 11 },
      stopReason: 'end_turn',
      raw: { source: 'cc-transcript' },
    });
    expect(message.blocks).toEqual([{ id: 'text-0', type: 'text', text: 'Done.' }]);
  });

  it('normalizes stream block events into frontend block events', () => {
    const deltaEvent = normalizeMessageStreamEvent({
      type: 'message.block.delta',
      conversation_id: 'session-1',
      message_id: 'msg-assistant-1',
      block_id: 'text-0',
      block_type: 'text',
      delta: 'Done.',
      block: { id: 'text-0', type: 'text' },
    }, 'session-1');
    const completedEvent = normalizeMessageStreamEvent({
      type: 'message.block.completed',
      conversation_id: 'session-1',
      message_id: 'msg-assistant-1',
      block: {
        id: 'tool-result-read',
        type: 'tool_result',
        title: '工具返回 · Read',
        name: 'Read',
        text: '读取完成。',
      },
    }, 'session-1');

    expect(deltaEvent).toEqual({
      type: 'message.block.delta',
      messageId: 'msg-assistant-1',
      blockId: 'text-0',
      blockType: 'text',
      delta: 'Done.',
      block: { id: 'text-0', type: 'text' },
    });
    expect(completedEvent).toEqual({
      type: 'message.block.completed',
      messageId: 'msg-assistant-1',
      block: {
        id: 'tool-result-read',
        type: 'tool_result',
        title: '工具返回 · Read',
        name: 'Read',
        text: '读取完成。',
      },
    });
  });

  it('normalizes skill completion events', () => {
    const event = normalizeMessageStreamEvent({
      type: 'skill.completed',
      message_id: 'msg-assistant-1',
      skill_call_id: 'call-1',
      skill_name: 'learning-plan',
      outcome: 'insufficient_input',
      summary: '缺少当前技能水平。',
      result: { missing: ['skill_level'] },
      started_at: '2026-08-13T10:00:00.000Z',
      completed_at: '2026-08-13T10:00:01.000Z',
      duration_ms: 1000,
      source: 'agent',
    }, 'session-1');

    expect(event).toEqual({
      type: 'skill.completed',
      messageId: 'msg-assistant-1',
      skillCallId: 'call-1',
      skillName: 'learning-plan',
      outcome: 'insufficient_input',
      summary: '缺少当前技能水平。',
      result: { missing: ['skill_level'] },
      startedAt: '2026-08-13T10:00:00.000Z',
      completedAt: '2026-08-13T10:00:01.000Z',
      durationMs: 1000,
      source: 'agent',
    });
  });

  it('normalizes AskUserQuestion blocks into a safe interactive question payload', () => {
    const event = normalizeMessageStreamEvent({
      type: 'message.block.completed',
      conversation_id: 'session-1',
      message_id: 'msg-assistant-1',
      block: {
        id: 'ask-question-tool-1',
        type: 'ask_question',
        title: '需要你的选择',
        name: 'AskUserQuestion',
        toolUseId: 'tool-1',
        status: 'pending',
        questions: [{
          header: '职业方向',
          question: '你希望优先探索哪条职业路径？',
          multiSelect: false,
          options: [
            { label: '产品经理', description: '探索产品规划与协作。' },
            { label: '数据分析', description: '探索数据驱动决策。', preview: 'SQL + Python' },
          ],
        }],
      },
    }, 'session-1');

    expect(event).toEqual({
      type: 'message.block.completed',
      messageId: 'msg-assistant-1',
      block: {
        id: 'ask-question-tool-1',
        type: 'ask_question',
        title: '需要你的选择',
        name: 'AskUserQuestion',
        toolUseId: 'tool-1',
        status: 'pending',
        questions: [{
          header: '职业方向',
          question: '你希望优先探索哪条职业路径？',
          multiSelect: false,
          options: [
            { label: '产品经理', description: '探索产品规划与协作。' },
            { label: '数据分析', description: '探索数据驱动决策。', preview: 'SQL + Python' },
          ],
        }],
      },
    });
  });

  it('keeps AskUserQuestion answers on the matching tool result for history rendering', () => {
    const event = normalizeMessageStreamEvent({
      type: 'message.block.completed',
      conversation_id: 'session-1',
      message_id: 'msg-assistant-1',
      block: {
        id: 'tool-result-1',
        type: 'tool_result',
        toolUseId: 'tool-1',
        answers: {
          '你希望优先探索哪条职业路径？': '产品经理',
          '目前最担心什么？': '已跳过',
        },
      },
    }, 'session-1');

    expect(event).toMatchObject({
      type: 'message.block.completed',
      block: {
        id: 'tool-result-1',
        type: 'tool_result',
        toolUseId: 'tool-1',
        answers: {
          '你希望优先探索哪条职业路径？': '产品经理',
          '目前最担心什么？': '已跳过',
        },
      },
    });
  });

  it('normalizes stream completion metadata without forcing absent reasoning to null', () => {
    const event = normalizeMessageStreamEvent({
      type: 'message.completed',
      conversation_id: 'session-1',
      message_id: 'uuid-user-1',
      assistant_message_id: 'msg-assistant-1',
      reply: 'Done.',
      raw: {
        model: 'claude-test',
        usage: { input_tokens: 3, output_tokens: 5 },
      },
    }, 'session-1');

    expect(event).toMatchObject({
      type: 'message.completed',
      threadId: 'session-1',
      messageId: 'uuid-user-1',
      assistantMessageId: 'msg-assistant-1',
      reply: 'Done.',
      model: 'claude-test',
      usage: { input_tokens: 3, output_tokens: 5 },
    });
    expect(event && 'reasoning' in event).toBe(false);
  });

  it('preserves numeric zero agent ids from upstream payloads', () => {
    const message = normalizeThreadMessage({
      id: 3,
      conversationId: 1,
      role: 'assistant',
      content: '系统 agent 返回。',
      agentId: 0,
      createdAt: 1776645161000,
    }, '1');

    expect(message.agentId).toBe('0');
  });
});

describe('normalizeProfileSuggestion', () => {
  it('copies array patches into a new suggestion object', () => {
    const incomingArray = ['Frontend implementation', 'AI-assisted delivery'];
    const suggestion = normalizeProfileSuggestion({
      row_id: 42,
      id: 'suggestion-strengths',
      title: 'Sharpen strengths',
      rationale: 'Use clearer phrasing.',
      source_thread_id: 'thread-002',
      patch: {
        coreSkills: incomingArray,
      },
    });

    expect(suggestion.rowId).toBe(42);
    expect(suggestion.sourceThreadId).toBe('thread-002');
    expect(suggestion.patch.careerProfile?.skills).toEqual(incomingArray);
    expect(suggestion.patch.careerProfile?.skills).not.toBe(incomingArray);
  });
});
