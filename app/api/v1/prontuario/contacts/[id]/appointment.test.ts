import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({scope:true,queries:[] as {table:string;filters:unknown[][];selection?:string}[],appointment:true,agendaOrg:"clinic",agendaScope:true,limitedAgenda:false,description:'Observação do compromisso\nChegar antes' as string|null,notes:'Trazer exames\nChegar antes' as string|null}));
vi.mock('@/lib/prontuario/contacts',async original=>({...await original<typeof import('@/lib/prontuario/contacts')>(),authorizeProntuario:vi.fn(async()=>state.scope?{ok:true,auth:{organizationId:'clinic',apiTokenId:'token'}}:{ok:false,response:new Response('',{status:403})})}));
vi.mock('@/lib/mcp/auth',async original=>({...await original<typeof import('@/lib/mcp/auth')>(),validateBearerToken:vi.fn(async()=>({organizationId:state.agendaOrg,role:"agent",scopes:state.agendaScope?[state.limitedAgenda?'agenda:read':'mcp:read']:[]}))}));
vi.mock('@/lib/audit/leitura',()=>({auditarLeitura:vi.fn()}));
vi.mock('@/lib/ai/dispatcher/rate-limit',()=>({checkRateLimit:vi.fn(async()=>({allowed:true}))}));
const id='11111111-1111-4111-8111-111111111111',appointmentId='22222222-2222-4222-8222-222222222222';
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:()=>({
 from(table:string){const query:{table:string;filters:unknown[][];selection?:string}={table,filters:[] as unknown[][]};state.queries.push(query);const chain={select:(selection:string)=>{query.selection=selection;return chain;},eq:(...args:unknown[])=>{query.filters.push(args);return chain;},is:()=>chain,maybeSingle:async()=>({error:null,data:table==='contacts'?{id,name:'Pessoa Teste',display_name:null,birthdate:null,phone_number:null,email:null,updated_at:'2026-10-01'}:table==='calendar_appointments'?(state.appointment?{id:appointmentId,title:'Consulta',description:state.description,notes:state.notes,event_type_id:'type',owner_user_id:'professional'}:null):table==='calendar_event_types'?{name:'Retorno'}:{user_id:'professional'}})};return chain;},
 auth:{admin:{getUserById:async()=>({data:{user:{user_metadata:{full_name:'Dra. Exemplo'},email:'private@example.test'}}})}}
})}));
const {GET}=await import('./route');
const request=(query='?appointment_id='+appointmentId)=>GET(new Request('https://example.test/api/v1/prontuario/contacts/'+id+query),{params:Promise.resolve({id})});
beforeEach(()=>{state.scope=true;state.appointment=true;state.agendaOrg="clinic";state.agendaScope=true;state.limitedAgenda=false;state.queries=[];state.description='Observação do compromisso\nChegar antes';state.notes='Trazer exames\nChegar antes';});
it('retorna detalhes apenas do compromisso do contato e da organização, sem divulgar email do profissional',async()=>{
 const r=await request();expect(r.status).toBe(200);const b=await r.json();
 expect(b.data.appointment).toEqual({id:appointmentId,title:'Consulta',type:'Retorno',professional:'Dra. Exemplo',description:state.description,notes:state.notes});
 for(const q of state.queries)expect(q.filters).toContainEqual(['organization_id','clinic']);
 expect(state.queries.find(q=>q.table==='calendar_appointments')?.filters).toContainEqual(['contact_id',id]);
 expect(state.queries.find(q=>q.table==='calendar_appointments')?.selection?.split(',')).toContain('description');
 expect(JSON.stringify(b)).not.toContain('private@example.test');
});
it('envia a observação do formulário mesmo sem anotação interna',async()=>{state.notes=null;const b=await(await request()).json();expect(b.data.appointment.description).toBe(state.description);expect(b.data.appointment.notes).toBeNull();});
it('preserva anotação interna sem apresentá-la como descrição',async()=>{state.description=null;const b=await(await request()).json();expect(b.data.appointment.description).toBeNull();expect(b.data.appointment.notes).toBe(state.notes);});
it('consulta normal de cadastro não carrega observações',async()=>{const b=await (await request('')).json();expect(b.data.appointment).toBeUndefined();expect(state.queries.map(q=>q.table)).toEqual(['contacts']);});
it('recusa compromisso de outro contato ou organização',async()=>{state.appointment=false;expect((await request()).status).toBe(404);});
it('recusa identificador inválido antes de consultar dados',async()=>{expect((await request('?appointment_id=invalid')).status).toBe(422);expect(state.queries).toHaveLength(0);});
it('mantém a autorização exclusiva da integração',async()=>{state.scope=false;expect((await request()).status).toBe(403);expect(state.queries).toHaveLength(0);});

it("exige autorização da agenda da mesma organização",async()=>{state.agendaOrg="other";expect((await request()).status).toBe(403);state.agendaOrg="clinic";state.agendaScope=false;expect((await request()).status).toBe(403);expect(state.queries).toHaveLength(0);});

it("aceita a credencial restrita à leitura da agenda já usada pelo prontuário",async()=>{state.limitedAgenda=true;expect((await request()).status).toBe(200);});
