// @vitest-environment node
import {it,expect,vi} from 'vitest';
import {validateProfile,requestAI,complete,endpoint} from './ai.js';
const profile={base_url:'https://model.example/v1',model:'chosen-model',api_key:'test-secret'};
it('rejects unsafe destinations before sending a credential',async()=>{
  const fetchImpl=vi.fn();
  for(const base_url of ['http://evil.example','https://user:pass@model.example','https://model.example?key=foo','javascript:alert(1)'])await expect(requestAI({...profile,base_url},'models',null,{fetchImpl})).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();expect(()=>validateProfile({...profile,model:''})).toThrow();
});
it('normalizes endpoints and sends exactly one request without cookies or redirects',async()=>{
  const fetchImpl=vi.fn().mockResolvedValue(Response.json({error:{message:'test-secret invalid'}},{status:401}));
  await expect(requestAI(profile,'chat/completions',{}, {fetchImpl})).rejects.toThrow('[已隐藏] invalid');
  expect(fetchImpl).toHaveBeenCalledTimes(1);expect(fetchImpl.mock.calls[0][1]).toMatchObject({credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
  expect(endpoint('https://model.example/v1/chat/completions','models')).toBe('https://model.example/v1/models');
});
it('rejects truncated output and honours cancellation without retry',async()=>{
  const fetchImpl=vi.fn().mockResolvedValue(Response.json({choices:[{message:{content:'partial'},finish_reason:'length'}]}));
  await expect(complete(profile,[],{fetchImpl})).rejects.toThrow('截断');expect(fetchImpl).toHaveBeenCalledTimes(1);
  const controller=new AbortController();controller.abort();fetchImpl.mockClear();await expect(requestAI(profile,'models',null,{signal:controller.signal,fetchImpl})).rejects.toThrow();expect(fetchImpl).not.toHaveBeenCalled();
});
it('rejects empty answers and exposes CORS errors accurately',async()=>{
  await expect(complete(profile,[],{fetchImpl:vi.fn().mockResolvedValue(Response.json({choices:[{message:{content:''}}]}))})).rejects.toThrow('空内容');
  await expect(requestAI(profile,'models',null,{fetchImpl:vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))})).rejects.toThrow('CORS');
});
