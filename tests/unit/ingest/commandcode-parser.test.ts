import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { assembleTurns } from '@/ingest/turns/assembler';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommandCodeSession } from '@/ingest/parser/commandcode';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
async function parse(rows: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'commandcode-')); dirs.push(dir);
  const file = join(dir, 'fixture.jsonl');
  writeFileSync(file, rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n'));
  return parseCommandCodeSession(file, 'fixture');
}
const header = { type: 'session', version: 3, id: 'cc-session', timestamp: '2026-10-20T12:00:00Z', cwd: '/fixture/project' };
function msg(id: string, role: string, content: unknown[], extra = {}) {
  return { type: 'message', id, parentId: null, timestamp: '2026-10-20T12:00:01Z', message: { role, content }, ...extra };
}
describe('Command Code persisted transcript', () => {
  it('replays text, reasoning, tool arguments/results, explicit turns and source-reported usage/cost', async () => {
    const result = await parse([header,
      msg('u1', 'user', [{ type: 'text', text: 'Investigate cost' }]),
      msg('a1', 'assistant', [{ type: 'thinking', thinking: 'Inspect totals' }, { type: 'text', text: 'Checking' }, { type: 'tool_use', id: 'call1', name: 'shell_command', input: { command: 'pwd' } }], { model: 'test-model', usage: { inputTokens: 400, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 40, costUsd: 0.125 } }),
      msg('r1', 'user', [{ type: 'tool_result', tool_use_id: 'call1', content: [{ type: 'text', text: '/fixture/project' }] }]),
      msg('a2', 'assistant', [{ type: 'text', text: 'Done' }], { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 0, costUsd: 0.025 } }),
      { type: 'session_info', name: 'Cost investigation' },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.session).toMatchObject({ id: 'commandcode:cc-session', name: 'Cost investigation', source: 'commandcode', cwd: '/fixture/project', sourceCostUsd: 0.15, costSource: 'source-reported', metrics: { inputTokens: 410, outputTokens: 25, cacheReadTokens: 320, cacheWriteTokens: 40, userMessageCount: 1 } });
    expect(result.session.metrics.totalTokens).toBe(435);
    expect(result.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    expect(result.messages.map(m => m.turnIndex)).toEqual([0, 0, 0, 0]);
    expect(result.messages[1].tokenUsage).toMatchObject({ inputTokens: 400, cacheReadTokens: 300, totalTokens: 420, usageSemantics: 'overlap', sourceCostUsd: 0.125 });
    expect(result.activities).toContainEqual(expect.objectContaining({ type: 'thinking', content: 'Inspect totals' }));
    expect(result.activities).toContainEqual(expect.objectContaining({ type: 'tool_call', id: 'commandcode:cc-session:call1', inputJson: '{"command":"pwd"}', status: 'success', messageOrdinal: 1, resultEvents: [expect.objectContaining({ content: '/fixture/project' })] }));
  });
  it('does not count tool results as user turns and preserves missing usage without invented ancestry', async () => {
    const result = await parse([header, msg('u1','user',[{type:'text',text:'one'}]), msg('a1','assistant',[{type:'tool_use',id:'agent1',name:'agent',input:{description:'Task',prompt:'Investigate'}}]), msg('r1','user',[{type:'tool_result',tool_use_id:'agent1',content:'Task complete'}]), msg('u2','user',[{type:'text',text:'two'}]), msg('a2','assistant',[{type:'text',text:'answer'}])]);
    expect(result.messages.map(m => m.turnIndex)).toEqual([0,0,0,1,1]);
    expect(result.session.sourceCostUsd).toBeNull();
    expect(result.messages[1].tokenUsage).toBeUndefined();
    expect(result.activities.filter(a => a.type === 'subagent_link')).toEqual([]);
    expect(result.session.parentSessionId).toBeUndefined();
    expect(result.warnings.join(' ')).toContain('subagent');
  });
  it('marks source costs partial when assistant calls lack costs and namespaces all recorded IDs', async () => {
    const result = await parse([header,
      msg('a1', 'assistant', [{ type: 'text', text: 'Recorded call' }], { usage: { inputTokens: 5, outputTokens: 2, costUsd: 0.1 } }),
      msg('a2', 'assistant', [{ type: 'text', text: 'Unpriced call' }]),
    ]);
    expect(result.session).toMatchObject({ sourceCostUsd: 0.1, costPricingStatus: 'partial' });
    expect(result.messages[0].id).toBe('commandcode:cc-session:a1');
    expect(result.warnings.join(' ')).toContain('incomplete');
  });

  it('deduplicates repeated message ids and reports malformed lines without transcript leakage', async () => {
    const m = msg('a1','assistant',[{type:'text',text:'answer'}],{usage:{inputTokens:7,outputTokens:3,costUsd:0.1}});
    const result = await parse([header,m,m,'{private malformed']);
    expect(result.messages).toHaveLength(1);
    expect(result.session.metrics.inputTokens).toBe(7);
    expect(result.session.sourceCostUsd).toBe(0.1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].raw).not.toContain('private');
  });
  it('assembles recorded costs/cache into the correct replay turn after database persistence', async () => {
    const result = await parse([header, msg('u1','user',[{type:'text',text:'one'}]), msg('a1','assistant',[{type:'text',text:'answer'}],{usage:{inputTokens:7,outputTokens:3,cacheReadTokens:100,costUsd:0.1}}), msg('u2','user',[{type:'text',text:'two'}]), msg('a2','assistant',[{type:'text',text:'answer two'}],{usage:{inputTokens:10,outputTokens:5,cacheReadTokens:200,costUsd:0.2}})]);
    const db = new Database(':memory:');
    try {
      db.exec(readFileSync(join(process.cwd(), 'ingest/db/schema.sql'), 'utf8'));
      db.prepare("INSERT INTO sessions (id,source,project,status,file_path) VALUES (?,?,?,?,?)").run(result.session.id,'commandcode','fixture','idle','fixture.jsonl');
      const insert = db.prepare('INSERT INTO messages (id,session_id,ordinal,role,content,token_usage_json,source_file,turn_id,turn_index,is_real_user_input) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const m of result.messages) insert.run(m.id,result.session.id,m.ordinal,m.role,m.content,JSON.stringify(m.tokenUsage ?? null),'fixture.jsonl',m.turnId,m.turnIndex,m.isRealUserInput ? 1 : 0);
      const turns = await assembleTurns(result.session.id, db);
      expect(turns).toHaveLength(2);
      expect(turns[0].tokenUsage).toMatchObject({sourceCostUsd:0.1,cacheReadTokens:100});
      expect(turns[1].tokenUsage).toMatchObject({sourceCostUsd:0.2,cacheReadTokens:200});
    } finally { db.close(); }
  });

  it('uses saved human-readable sidecar titles without requiring transcript session_info', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'commandcode-title-')); dirs.push(dir);
    const file = join(dir, 'title.jsonl');
    writeFileSync(file, [JSON.stringify(header), JSON.stringify({type:'session_info',name:'Older transcript title'})].join('\n'));
    writeFileSync(join(dir, 'title.meta.json'), JSON.stringify({title:'Readable session title'}));
    const result = await parseCommandCodeSession(file, 'fixture');
    expect(result.session.name).toBe('Readable session title');
  });

});
