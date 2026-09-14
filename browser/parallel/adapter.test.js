// @vitest-environment node
import 'fake-indexeddb/auto';
import {beforeEach,afterAll,expect,it,vi} from 'vitest';
vi.mock('./engine/core/pipeline/browserStages',()=>({createBrowserPipelineStages:vi.fn()}));
vi.mock('./engine/core/pdf/runtime',()=>({getDocument:vi.fn()}));
import {PaperParallelDb} from './engine/core/project/db';
import {clearParallelCache,editorRows,editTranslation,validateParallelSpec,DATABASE} from './adapter';
const database=new PaperParallelDb(DATABASE);
beforeEach(async()=>{for(const table of database.tables)await table.clear()});
afterAll(()=>database.close());
it('clears only the selected paper engine cache, including source plans and editor data',async()=>{
  for(const id of ['a','b']){
    const projectId='icrf-pp-'+id;
    await database.tasks.put({projectId});await database.aiLogs.put({projectId,entries:[]});
    await database.translations.put({projectId,key:id,translation:'译文'});
    await database.artifacts.put({projectId,key:id,kind:'accepted-page-plan',blob:new Blob(['plan'])});
  }
  await clearParallelCache('a');
  for(const table of database.tables)expect(await table.count()).toBe(1);
  expect((await database.translations.get('b')).translation).toBe('译文');
});
it('saves corrected text with a new semantic mapping and rejects changed protected numbers',async()=>{
  const request={blockId:'blk-1',kind:'paragraph',source:'We use 42 threads.',protectedTokens:['42'],
    alignmentMode:'sentence-candidates',sourceSentences:[{id:'s1',text:'We use 42 threads.'}]};
  await database.artifacts.put({key:'icrf-pp-a:editor-input',projectId:'icrf-pp-a',kind:'icrf-editor-input',
    blob:new Blob([JSON.stringify([{key:'cached',block_id:'blk-1',source_pages:[1],request}])])});
  await database.translations.put({key:'cached',projectId:'icrf-pp-a',blockId:'blk-1',translation:'采用 42 个线程。',validatedAt:10});
  await expect(editTranslation('a','blk-1','我们采用 24 个线程。',10)).rejects.toThrow('保护');
  expect((await database.translations.get('cached')).translation).toBe('采用 42 个线程。');
  await editTranslation('a','blk-1','我们使用 42 个线程。',10);
  expect((await editorRows('a'))[0]).toMatchObject({target:'我们使用 42 个线程。',edited:true});
  expect((await database.translations.get('cached')).alignmentGroups).toEqual([{sourceSentenceIds:['s1'],targetSegments:['我们使用 42 个线程。']}]);
  await expect(editTranslation('a','blk-1','旧版本修改',10)).rejects.toThrow('已更新');
});
it('normalizes the old Flash name only within the PDF engine and rejects unsupported output languages',()=>{
  expect(validateParallelSpec({profile:{model:'deepseek-v4-flash'}})).toBe('deepseek-flash');
  expect(()=>validateParallelSpec({profile:{model:'another-model'}})).toThrow('请选择');
  expect(()=>validateParallelSpec({target:'en',profile:{model:'deepseek-flash'}})).toThrow('简体中文');
});
