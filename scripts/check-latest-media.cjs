const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(process.env.USERPROFILE, '.agent-memory', 'agent-memory.db'), {
  readonly: true,
});

const rows = db.prepare(`
  SELECT id, memory_session_id, project, request, media_context, created_at
  FROM session_summaries
  WHERE project LIKE '%agent-memory%'
  ORDER BY id DESC
  LIMIT 12
`).all();

for (const r of rows) {
  console.log(`\n#${r.id} ${r.created_at} ${r.memory_session_id} ${r.project}`);
  console.log(`request: ${r.request}`);
  console.log(`media: ${r.media_context}`);
}

const sid = rows[0]?.memory_session_id;
if (sid) {
  const session = db.prepare(`
    SELECT content_session_id, memory_session_id, user_prompt, last_assistant_message, transcript_path
    FROM sdk_sessions
    WHERE memory_session_id=?
  `).get(sid);
  console.log('\n=== latest sdk_session ===');
  console.log(JSON.stringify({
    content_session_id: session?.content_session_id,
    memory_session_id: session?.memory_session_id,
    user_prompt: session?.user_prompt,
    transcript_path: session?.transcript_path,
    last_assistant_message_prefix: session?.last_assistant_message?.slice(0, 1200),
    last_assistant_message_length: session?.last_assistant_message?.length,
  }, null, 2));
}
