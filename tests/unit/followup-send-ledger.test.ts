import { expect, it, vi } from "vitest";
import { sendWithLedger } from "@/lib/agent-engine/edge/crm/send-ledger";
type Store=Parameters<typeof sendWithLedger>[0];
const intent={tenantId:'org',leadId:'contact',jobId:'job',seq:1,body:'Retomar consulta'};
function store(status='requested',message:{id:string;status:string}|null=null):Store{
 return {create:vi.fn(async()=>{throw {code:'23505'};}),find:vi.fn(async()=>({id:'ledger-original',status:status as 'requested',crm_message_id:message?.id??null})),rotate:vi.fn(async()=> 'new-ledger'),message:vi.fn(async()=>message),update:vi.fn(async()=>{})};
}
it('executor novo reconhece aceito sem chamar transporte novamente',async()=>{
 const db=store('accepted',{id:'message',status:'sent'}),send=vi.fn();
 expect(await sendWithLedger(db,intent,send)).toEqual({kind:'already_sent',idempotencyKey:'ledger-original',crmMessageId:'message'});expect(send).not.toHaveBeenCalled();
});
it('crash depois do transporte reconcilia mensagem aceita mesmo com ledger requested',async()=>{
 const db=store('requested',{id:'message',status:'delivered'}),send=vi.fn();
 expect((await sendWithLedger(db,intent,send)).kind).toBe('sent');expect(send).not.toHaveBeenCalled();expect(db.update).toHaveBeenCalledWith('org','ledger-original','accepted','message',null);
});
it('queued retorna ao handler com MESMAS identidades; sending não reenvia em voo',async()=>{
 const db=store('queued',{id:'legacy-message',status:'queued'}),send=vi.fn(async()=>({id:'legacy-message',status:'sent'}));
 expect((await sendWithLedger(db,intent,send)).kind).toBe('sent');expect(send).toHaveBeenCalledWith('ledger-original','legacy-message');
 const busy=store('requested',{id:'message',status:'sending'}),again=vi.fn();
 expect((await sendWithLedger(busy,intent,again)).kind).toBe('queued');expect(again).not.toHaveBeenCalled();
});
it('falha explícita permite tentativa nova; ausência de recibo após conflito falha fechado',async()=>{
 const db=store('failed'),send=vi.fn(async(_key:string,id:string)=>({id,status:'sent'}));
 expect((await sendWithLedger(db,intent,send)).kind).toBe('sent');expect(send).toHaveBeenCalledWith('new-ledger','new-ledger');
 db.find=vi.fn(async()=>null);await expect(sendWithLedger(db,intent,vi.fn())).rejects.toThrow('send_ledger_missing');
});
it('mensagem failed/queued nunca confirma sent',async()=>{
 for(const status of ['failed','queued']){
  const db=store();const send=vi.fn(async()=>({id:'message',status}));
  expect((await sendWithLedger(db,intent,send)).kind).toBe(status);expect(db.update).not.toHaveBeenCalledWith('org','ledger-original','accepted',expect.anything(),expect.anything());
 }
});
it('hash sem mídia é o de sempre; com mídia inclui item e variante',async()=>{
 const {createHash}=await import('node:crypto');const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
 const fresh=()=>({...store(),create:vi.fn(async()=> 'k')});const send=vi.fn(async()=>({id:'m',status:'sent'}));
 const sem=fresh();await sendWithLedger(sem,intent,send);expect(sem.create).toHaveBeenCalledWith(intent,sha('Retomar consulta'));
 const com=fresh();const midia={...intent,mediaLibraryItemId:'item-1',mediaVariant:'B' as const};await sendWithLedger(com,midia,send);
 expect(com.create).toHaveBeenCalledWith(midia,sha('Retomar consulta\u0000item-1\u0000B'));
 const semVariante=fresh();await sendWithLedger(semVariante,{...intent,mediaLibraryItemId:'item-1'},send);
 expect(semVariante.create).toHaveBeenCalledWith(expect.anything(),sha('Retomar consulta\u0000item-1\u0000'));
});
it('422 media_not_* fecha o ledger como failed com o código e propaga',async()=>{
 const {ApiError}=await import('@/lib/api/types');
 for(const code of ['media_not_found','media_not_ready']){
  const db={...store(),create:vi.fn(async()=> 'k')};const err=new ApiError(422,code,undefined,'req','Mídia recusada.');
  await expect(sendWithLedger(db,intent,vi.fn(async()=>{throw err;}))).rejects.toBe(err);
  expect(db.update).toHaveBeenCalledWith('org','k','failed',null,code);
 }
 const outra={...store(),create:vi.fn(async()=> 'k')};const val=new ApiError(422,'validation_error',undefined,'req');
 await expect(sendWithLedger(outra,intent,vi.fn(async()=>{throw val;}))).rejects.toBe(val);expect(outra.update).not.toHaveBeenCalled();
});
