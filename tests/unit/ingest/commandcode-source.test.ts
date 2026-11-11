import { getConfig } from '@/ingest/config';
import { syncSource, syncPaths } from '@/ingest/sync';
import { openDatabase, initSchema, closeDatabase } from '@/ingest/db';
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { resolveToolDirs } from '@/ingest/config/tool-dirs';
import * as sources from '@/ingest/sync/sources';
import { assertSourceToolId, getDefinition } from '@/lib/agent-tools/registry';
import { getSourceLabel } from '@/types/trace';

describe('Command Code source integration', () => {
  it('registers a real source with replay and cost visibility without claiming unrecorded relationships', () => {
    expect(assertSourceToolId('commandcode')).toBe('commandcode');
    expect(getSourceLabel('commandcode')).toBe('Command Code');
    expect(getDefinition('commandcode').capabilities).toMatchObject({ replay: true, cost: true, subagents: false });
    expect(resolveToolDirs({}).get('commandcode')).toEqual([join(homedir(), '.commandcode/projects')]);
  });

  it('discovers nested transcript directories without treating hook telemetry as sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commandcode-discovery-'));
    try {
      await mkdir(join(root, 'workspace', 'subagents'), { recursive: true });
      const transcript = JSON.stringify({ type: 'session', id: 'abc', timestamp: '2026-01-01T00:00:00Z' }) + '\n';
      await writeFile(join(root, 'workspace', 'abc.jsonl'), transcript);
      await writeFile(join(root, 'workspace', 'subagents', 'def.jsonl'), transcript);
      await writeFile(join(root, 'workspace', 'hooks.jsonl'), JSON.stringify({ event: 'tool_start' }) + '\n');
      const discover = (sources as unknown as { discoverCommandCodeSources: (dirs: string[]) => Promise<Array<{sessionCount:number}>> }).discoverCommandCodeSources;
      expect(typeof discover).toBe('function');
      expect((await discover([root])).map(s => s.sessionCount)).toEqual([1, 1]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains saved human titles through normal discovery, sync and storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commandcode-sync-'));
    const db = openDatabase({path:join(root,'test.db')});
    const previous = getConfig().toolDirs.get('commandcode');
    getConfig().toolDirs.set('commandcode',[root]);
    try {
      initSchema();
      await writeFile(join(root,'session.jsonl'), [JSON.stringify({type:'session',version:3,id:'title-test',cwd:'/fixture'}),JSON.stringify({type:'session_info',name:'Transcript title'}),JSON.stringify({type:'message',id:'u1',message:{role:'user',content:[{type:'text',text:'A first prompt differs from saved title'}]}})].join('\n'));
      await writeFile(join(root,'session.meta.json'), JSON.stringify({title:'My saved title'}));
      const result = await syncSource('commandcode',{basePath:root,force:true});
      expect(result.errors).toEqual([]);
      expect(db.prepare('SELECT name FROM sessions WHERE id=?').get('commandcode:title-test')).toEqual({name:'My saved title'});
      expect((await syncSource('commandcode')).metrics?.filesSkippedBeforeParse).toBe(1);
      await writeFile(join(root, 'session.meta.json'), JSON.stringify({ title: 'Renamed without transcript change' }));
      expect((await syncSource('commandcode')).errors).toEqual([]);
      expect(db.prepare('SELECT name FROM sessions WHERE id=?').get('commandcode:title-test')).toEqual({ name: 'Renamed without transcript change' });
      await writeFile(join(root, 'session.meta.json'), JSON.stringify({ title: 'Watcher rename' }));
      const changed = await syncPaths('commandcode', [join(root, 'session.meta.json'), join(root, 'session.jsonl')]);
      expect(changed.errors).toEqual([]);
      expect(changed.metrics?.filesParsed).toBe(1);
      expect(db.prepare('SELECT name FROM sessions WHERE id=?').get('commandcode:title-test')).toEqual({ name: 'Watcher rename' });
      await rm(join(root, 'session.meta.json'));
      expect((await syncPaths('commandcode', [join(root, 'session.meta.json')])).errors).toEqual([]);
      expect(db.prepare('SELECT name FROM sessions WHERE id=?').get('commandcode:title-test')).toEqual({ name: 'Transcript title' });
    } finally { getConfig().toolDirs.set('commandcode',previous ?? []); closeDatabase(); await rm(root,{recursive:true,force:true}); }
  });

});
