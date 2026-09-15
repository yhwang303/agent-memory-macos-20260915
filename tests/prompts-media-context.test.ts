import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryPrompt, type SDKSession } from '../src/sdk/prompts.js';

function baseSession(overrides: Partial<SDKSession> = {}): SDKSession {
  return {
    id: 0,
    memory_session_id: 's1',
    project: '/tmp/p',
    user_prompt: 'hello',
    last_assistant_message: '',
    observations: [],
    ...overrides,
  };
}

test('media_context slot omitted when no image signal anywhere', () => {
  const prompt = buildSummaryPrompt(
    baseSession({
      user_prompt: '请帮我修一个 bug',
      last_assistant_message: '好的，我检查了代码并修复了空指针问题。',
    })
  );
  assert.ok(!prompt.includes('<media_context>'), 'slot should be absent when no media signal');
});

test('media_context slot present when assistant text contains image vocabulary', () => {
  const prompt = buildSummaryPrompt(
    baseSession({
      user_prompt: '看看这段代码',
      last_assistant_message: '这张截图展示了一个架构图，包含三层服务。',
    })
  );
  assert.ok(prompt.includes('<media_context>'), 'slot should appear when assistant described an image');
  assert.ok(prompt.includes('MEDIA CONTEXT'), 'rule #6 should appear');
});

test('media_context slot present when user_prompt carries Cursor [Image] marker', () => {
  const prompt = buildSummaryPrompt(
    baseSession({
      user_prompt:
        '[Image]\n<image_files>\n1. C:\\path\\image.png\n</image_files>\n<user_query>\n描述这张图\n</user_query>',
      last_assistant_message: '',
    })
  );
  assert.ok(prompt.includes('<media_context>'), 'image marker in user_prompt alone must trigger slot');
});

test('media_context slot present when assistant text contains <image_files> marker', () => {
  const prompt = buildSummaryPrompt(
    baseSession({
      user_prompt: 'x',
      last_assistant_message:
        '用户贴了一张 <image_files>...</image_files>，我分析了其中的表格数据。',
    })
  );
  assert.ok(prompt.includes('<media_context>'), 'image marker in assistant msg must trigger slot');
});

test('empty last_assistant_message + no markers anywhere -> slot omitted', () => {
  const prompt = buildSummaryPrompt(
    baseSession({
      user_prompt: 'generic task without images',
      last_assistant_message: '',
    })
  );
  assert.ok(!prompt.includes('<media_context>'), 'no signal -> no slot');
});

test('[USER_POSTED_IMAGE] marker triggers slot even when assistant text has no image vocab', () => {
  const prompt = buildSummaryPrompt(
    baseSession({
      user_prompt: '没修好哦，media_context 还是 null',
      last_assistant_message:
        '[USER_POSTED_IMAGE]\n\n对，修好了。看 #2023 的结果：\n- media_context 正确填了占位文本\n- meta_intent 也对',
    })
  );
  assert.ok(prompt.includes('<media_context>'), 'marker alone must trigger slot');
  assert.ok(
    prompt.includes('Sole source') && prompt.includes('transcript: reply to the user turn that included an image'),
    'rule #6 should tie media_context to transcript-sourced last response'
  );
  assert.ok(
    !prompt.includes('[USER_POSTED_IMAGE]'),
    'marker must be stripped from the prompt body shown to the LLM'
  );
});

test('[USER_POSTED_IMAGE] marker is stripped from Agent Last Response section', () => {
  const prompt = buildSummaryPrompt(
    baseSession({
      user_prompt: 'hi',
      last_assistant_message: '[USER_POSTED_IMAGE]\n\n这是我的回复正文，不涉及图片描述。',
    })
  );
  assert.ok(prompt.includes('这是我的回复正文'), 'body still shown');
  assert.ok(!prompt.includes('[USER_POSTED_IMAGE]'), 'marker stripped');
});

test('rule #6 instructs brief description, not verbatim copy', () => {
  const prompt = buildSummaryPrompt(
    baseSession({
      user_prompt: 'x',
      last_assistant_message: '这张截图展示了一个 UI',
    })
  );
  assert.ok(prompt.includes('Briefly describe'), 'rule #6 should say "Briefly describe"');
  assert.ok(!prompt.includes('COPY VERBATIM'), 'should NOT contain COPY VERBATIM anymore');
});

test('all observation types are included in observations summary count', () => {
  const prompt = buildSummaryPrompt(
    baseSession({
      user_prompt: 'x',
      observations: [
        { id: 1, type: 'bugfix', title: 'Fixed null pointer', narrative: 'Guarded against null.' },
        { id: 2, type: 'image_description', title: 'Image desc', narrative: 'Shows a UI.' },
      ],
    })
  );
  assert.match(prompt, /## Session Observations \(2 total\)/, 'all obs counted');
  assert.ok(prompt.includes('Fixed null pointer'), 'regular obs listed');
  assert.ok(prompt.includes('Image desc'), 'image_description obs also listed');
});
