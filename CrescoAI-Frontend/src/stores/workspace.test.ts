import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasCompletedInteractiveToolReply,
  mergeMessageRaw,
  preserveCompletedLiveReplies,
  useWorkspaceStore,
} from './workspace';

describe('useWorkspaceStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('deduplicates skill results by runtime call id when raw payloads merge', () => {
    const first = {
      skillCallId: 'call-1',
      skillName: 'learning-plan',
      outcome: 'success',
      summary: 'first',
      startedAt: '2026-08-13T10:00:00.000Z',
      completedAt: '2026-08-13T10:00:01.000Z',
      durationMs: 1000,
      source: 'agent',
    } as const;
    const merged = mergeMessageRaw(
      { skillResults: [first] },
      { skillResults: [{ ...first, summary: 'latest' }] },
    );

    expect(merged?.skillResults).toEqual([{ ...first, summary: 'latest' }]);
  });

  it('closes the active artifact when switching threads', async () => {
    const workspaceStore = useWorkspaceStore();

    await workspaceStore.setActiveThread('thread-001');
    await workspaceStore.openArtifact('artifact-mock-interview', 'immersive');

    expect(workspaceStore.artifactPaneOpen).toBe(true);
    expect(workspaceStore.activeArtifactId).toBe('artifact-mock-interview');
    expect(workspaceStore.artifactViewMode).toBe('immersive');

    await workspaceStore.setActiveThread('thread-002');

    expect(workspaceStore.activeThreadId).toBe('thread-002');
    expect(workspaceStore.artifactPaneOpen).toBe(false);
    expect(workspaceStore.activeArtifactId).toBeNull();
    expect(workspaceStore.artifactViewMode).toBe('pane');
  });

  it('falls back to the first known thread when a route thread id is unknown', async () => {
    const workspaceStore = useWorkspaceStore();

    const activeThreadId = await workspaceStore.setActiveThread('unknown-thread');

    expect(activeThreadId).toBe('thread-001');
    expect(workspaceStore.activeThreadId).toBe('thread-001');
    expect(workspaceStore.messagesStatus).toBe('ready');
    expect(workspaceStore.messages.length).toBeGreaterThan(0);
  });

  it('creates a local mock thread with provided summary seed and leaves messages idle for route-driven loading', async () => {
    const workspaceStore = useWorkspaceStore();

    await workspaceStore.initialize();
    const thread = await workspaceStore.createThread({
      title: '测试会话',
      preview: '用于验证首页首发起草稿。',
    });

    expect(thread.title).toBe('测试会话');
    expect(thread.preview).toBe('用于验证首页首发起草稿。');
    expect(workspaceStore.threads[0]?.id).toBe(thread.id);
    expect(workspaceStore.activeThreadId).toBe(thread.id);
    expect(workspaceStore.threadCreateStatus).toBe('ready');
    expect(workspaceStore.messages).toEqual([]);
    expect(workspaceStore.messagesStatus).toBe('idle');
  });

  it('creates a thread from the first submission and sends the draft immediately', async () => {
    const workspaceStore = useWorkspaceStore();

    await workspaceStore.initialize();
    const thread = await workspaceStore.startThreadFromDraft({
      content: '请帮我梳理本周重点工作和学习安排',
      attachments: [],
    });
    await vi.waitFor(() => {
      expect(workspaceStore.messageSubmitStatus).toBe('ready');
    });

    expect(thread).not.toBeNull();
    expect(thread?.title).toBe('请帮我梳理本周重点工作和学习安排');
    expect(workspaceStore.messagesStatus).toBe('ready');
    expect(workspaceStore.messages).toHaveLength(2);
    expect(workspaceStore.messages[0]).toMatchObject({
      threadId: thread!.id,
      role: 'user',
      content: '请帮我梳理本周重点工作和学习安排',
    });

    await workspaceStore.setActiveThread(thread!.id);

    expect(workspaceStore.messagesStatus).toBe('ready');
    expect(workspaceStore.messages).toHaveLength(2);
    expect(workspaceStore.messages[0]).toMatchObject({
      threadId: thread!.id,
      role: 'user',
      content: '请帮我梳理本周重点工作和学习安排',
    });
    expect(workspaceStore.messages[1]?.role).toBe('assistant');
  });

  it('removes a thread from the local mock workspace', async () => {
    const workspaceStore = useWorkspaceStore();

    await workspaceStore.initialize();
    const thread = await workspaceStore.createThread({
      title: '待删除会话',
      preview: '验证删除对话。',
    });

    await workspaceStore.deleteThread(thread.id);

    expect(workspaceStore.threads.some((item) => item.id === thread.id)).toBe(false);
    expect(workspaceStore.threadDeleteStatus).toBe('ready');
    expect(workspaceStore.activeThreadId).not.toBe(thread.id);
  });

  it('uploads local image media and file attachments when submitting a draft message', async () => {
    const workspaceStore = useWorkspaceStore();
    workspaceStore.activeThreadId = 'thread-001';

    await workspaceStore.submitDraftMessage({
      content: '',
      attachments: [
        {
          id: 'local-image-001',
          kind: 'image',
          name: 'diagram.png',
          url: 'blob:http://localhost/image',
          mimeType: 'image/png',
          sizeBytes: 2048,
        },
        {
          id: 'local-file-001',
          kind: 'file',
          name: 'resume.pdf',
          url: 'blob:http://localhost/file',
          mimeType: 'application/pdf',
          sizeBytes: 4096,
        },
      ],
    });

    const sentMessage = workspaceStore.messages.find((message) => message.content === '（已添加附件）');

    expect(sentMessage).toMatchObject({
      role: 'user',
      content: '（已添加附件）',
      media: [
        {
          id: expect.any(String),
          kind: 'image',
          url: expect.stringMatching(/^blob:/),
          title: 'diagram.png',
          mimeType: 'image/png',
        },
      ],
      files: [
        {
          id: expect.any(String),
          name: 'resume.pdf',
          url: expect.stringMatching(/^blob:/),
          mimeType: 'application/pdf',
          sizeBytes: 4096,
        },
      ],
    });
    expect(workspaceStore.messages[workspaceStore.messages.length - 1]?.role).toBe('assistant');
  });

  it('does not duplicate mock user messages after loading a thread before submitting', async () => {
    const workspaceStore = useWorkspaceStore();

    await workspaceStore.initialize();
    const thread = await workspaceStore.createThread({
      title: '重复检查',
      preview: '验证 mock 发送不会重复用户消息。',
    });
    await workspaceStore.setActiveThread(thread.id);

    await workspaceStore.submitDraftMessage({
      content: '事实上是啥',
      attachments: [],
    });

    expect(workspaceStore.messages.filter((message) => (
      message.role === 'user' && message.content === '事实上是啥'
    ))).toHaveLength(1);
    expect(workspaceStore.messages.filter((message) => (
      message.role === 'assistant' && message.content === '已收到你的消息。mock 模式下不会调用真实后端。'
    ))).toHaveLength(1);
  });

  it('keeps a completed interactive reply when the immediate history refresh is stale', () => {
    const reconciled = preserveCompletedLiveReplies([
      {
        id: 'assistant-1',
        threadId: 'thread-1',
        role: 'assistant',
        kind: 'markdown',
        content: '已根据你的选择继续处理。',
        blocks: [
          {
            id: 'ask-question-tool-1',
            type: 'ask_question',
            toolUseId: 'tool-1',
            status: 'pending',
            questions: [{
              header: '状态测试',
              question: '请选择？',
              options: [
                { label: '正常', description: '正常路径' },
                { label: '异常', description: '异常路径' },
              ],
              multiSelect: false,
            }],
          },
          { id: 'text-0', type: 'text', text: '已根据你的选择继续处理。' },
        ],
        streaming: false,
        createdAt: '2026-07-18T04:04:14.172Z',
      },
    ], [
      {
        id: 'assistant-1',
        threadId: 'thread-1',
        role: 'assistant',
        kind: 'markdown',
        content: '',
        blocks: [{
          id: 'ask-question-tool-1',
          type: 'ask_question',
          toolUseId: 'tool-1',
          status: 'pending',
          questions: [{
            header: '状态测试',
            question: '请选择？',
            options: [
              { label: '正常', description: '正常路径' },
              { label: '异常', description: '异常路径' },
            ],
            multiSelect: false,
          }],
        }],
        createdAt: '2026-07-18T04:04:14.172Z',
      },
    ]);

    expect(reconciled[0]).toMatchObject({
      content: '已根据你的选择继续处理。',
      streaming: false,
    });
    expect(reconciled[0]?.blocks?.some((block) => block.type === 'ask_question')).toBe(true);
    expect(reconciled[0]?.blocks?.some((block) => block.type === 'text')).toBe(true);
  });

  it('recognizes an interactive reply when transcript projection separates the question and answer', () => {
    expect(hasCompletedInteractiveToolReply([
      {
        id: 'assistant-question',
        threadId: 'thread-1',
        role: 'assistant',
        kind: 'markdown',
        content: '',
        blocks: [{
          id: 'ask-question-tool-1',
          type: 'ask_question',
          toolUseId: 'tool-1',
          questions: [{
            header: '状态测试',
            question: '请选择？',
            options: [
              { label: '正常', description: '正常路径' },
              { label: '异常', description: '异常路径' },
            ],
            multiSelect: false,
          }],
        }],
        createdAt: '2026-07-18T04:04:14.172Z',
      },
      {
        id: 'assistant-final',
        threadId: 'thread-1',
        role: 'assistant',
        kind: 'markdown',
        content: '最终状态已同步。',
        createdAt: '2026-07-18T04:04:20.172Z',
      },
    ], 'tool-1')).toBe(true);
  });

  it('does not mistake an interim reply before the question for a completed interactive reply', () => {
    const messages = [{
      id: 'assistant-question',
      threadId: 'thread-1',
      role: 'assistant' as const,
      kind: 'markdown' as const,
      content: 'Assistant is thinking...',
      stopReason: 'tool_use',
      blocks: [
        { id: 'status-0', type: 'status' as const, text: '正在调用工具。' },
        {
          id: 'ask-question-tool-1',
          type: 'ask_question' as const,
          toolUseId: 'tool-1',
          questions: [{
            question: '请选择。',
            header: '状态测试',
            options: [{ label: '通过', description: '正常' }],
            multiSelect: false,
          }],
        },
        { id: 'text-0', type: 'text' as const, text: 'Assistant is thinking...' },
      ],
      createdAt: '2026-07-18T04:21:11.987Z',
    }];

    expect(hasCompletedInteractiveToolReply(messages, 'tool-1')).toBe(false);
    expect(hasCompletedInteractiveToolReply([
      {
        ...messages[0],
        stopReason: 'end_turn',
        blocks: [
          ...messages[0].blocks!,
          { id: 'text-0', type: 'text' as const, text: '实时结果已显示。' },
        ],
      },
    ], 'tool-1')).toBe(true);
  });

  it('revokes local blob attachment urls before clearing messages on thread switch', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const workspaceStore = useWorkspaceStore();

    workspaceStore.activeThreadId = 'thread-001';
    workspaceStore.messages = [
      {
        id: 'message-local-attachment',
        threadId: 'thread-001',
        role: 'user',
        kind: 'markdown',
        content: '本地附件',
        media: [
          {
            id: 'local-image',
            kind: 'image',
            url: 'blob:http://localhost/image',
            posterUrl: 'blob:http://localhost/poster',
          },
        ],
        files: [
          {
            id: 'local-file',
            name: 'resume.pdf',
            url: 'blob:http://localhost/file',
          },
        ],
        createdAt: '2026-04-20 16:00',
      },
    ];

    await workspaceStore.setActiveThread('thread-002');

    expect(revokeSpy).toHaveBeenCalledWith('blob:http://localhost/image');
    expect(revokeSpy).toHaveBeenCalledWith('blob:http://localhost/poster');
    expect(revokeSpy).toHaveBeenCalledWith('blob:http://localhost/file');

    revokeSpy.mockRestore();
  });
});
