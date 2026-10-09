import { beforeAll, describe, expect, it } from 'vitest';
import { lastLine, sql } from './gov-helpers';
const ORG='03130000-0000-4000-8000-000000000001', OTHER='03130000-0000-4000-8000-000000000002', USER='03130000-0000-4000-8000-000000000003', TOKEN='03130000-0000-4000-8000-000000000004', PATIENT='03130000-0000-4000-8000-000000000005';
const address={logradouro:'Rua Fictícia',numero:'10',cidade:'Vitória',uf:'ES',cep:'29000000',complemento:'Sala 2'};
const json=(q:string)=>JSON.parse(lastLine(sql(q))) as Record<string,unknown>;
const create=(cpf='52998224725')=>`select public.fn_prontuario_create_contact_v2('${ORG}','${PATIENT}','Paciente de Teste','1990-01-01','+5527999990000','teste@example.test','${PATIENT}','${TOKEN}','${cpf}','${JSON.stringify(address)}');`;
beforeAll(()=>{sql(`
 insert into private.app_secrets(name,value) values('nuvemshop_oauth_key','fixture-key-0313-only-local-not-a-secret') on conflict(name) do update set value=excluded.value;
 insert into auth.users(id,email) values('${USER}','demographics@invariant.test');
 insert into public.organizations(id,slug,legal_name,display_name) values('${ORG}','demographics-test','Test','Test'),('${OTHER}','demographics-other','Other','Other');
 insert into public.api_tokens(id,organization_id,created_by,name,prefix,token_hash,scopes) values('${TOKEN}','${ORG}','${USER}','Test','dsk_test',decode(repeat('a',64),'hex'),'["prontuario:contacts:write"]');
 `);});
describe('cadastro ampliado do prontuário',()=>{
 it('cria e repete sem duplicar, cifrando CPF e projetando endereço para a tela existente',()=>{
  const first=json(create());expect(first.created).toBe(true);expect(json(create())).toMatchObject({id:first.id,created:false});
  const row=json(`select jsonb_build_object('matches',cpf_hash=public.cpf_indice('52998224725'),'encrypted',cpf_encrypted is not null,'address',custom_fields->>'endereco','raw',custom_fields::text like '%52998224725%') from public.contacts where id='${first.id}';`);
  expect(row).toMatchObject({matches:true,encrypted:true,raw:false});expect(row.address).toContain('Rua Fictícia');
  expect(()=>sql(create('11144477735'))).toThrow();
 });
 it('preserva campos vazios, endereço parcial e outros custom_fields; retry não duplica',()=>{
  const id=lastLine(sql(`select contact_id from public.prontuario_contact_links where source_patient_id='${PATIENT}'`));
  sql(`update public.contacts set custom_fields=custom_fields||'{"origem":"fixture"}'::jsonb where id='${id}';`);
  const stamp=lastLine(sql(`select updated_at from public.contacts where id='${id}'`));
  const call=`select public.fn_prontuario_patch_contact_v2('${ORG}','${PATIENT}','${id}',1,'${stamp}','Nome Atualizado',null,'','','${TOKEN}',null,'{"numero":"","complemento":"Sala 3"}');`;
  expect(json(call).applied).toBe(true);expect(json(call).applied).toBe(false);
  const row=json(`select jsonb_build_object('birth',birthdate,'email',email,'phone',phone_number,'cpf',cpf_hash=public.cpf_indice('52998224725'),'fields',custom_fields) from public.contacts where id='${id}';`);
  expect(row).toMatchObject({birth:'1990-01-01',email:'teste@example.test',phone:'+5527999990000',cpf:true,fields:{origem:'fixture',endereco_estruturado:{numero:'10',complemento:'Sala 3'}}});
  expect(()=>sql(call.replace('Sala 3','Sala 4'))).toThrow();
  expect(()=>sql(call.replace(ORG,OTHER))).toThrow();
 });
 it('CPF divergente bloqueia toda a revisão; endereço livre não é substituído por fragmento',()=>{
  const id=lastLine(sql(`select contact_id from public.prontuario_contact_links where source_patient_id='${PATIENT}'`));
  const stamp=lastLine(sql(`select updated_at from public.contacts where id='${id}'`));
  expect(()=>sql(`select public.fn_prontuario_patch_contact_v2('${ORG}','${PATIENT}','${id}',2,'${stamp}','Não Gravar',null,'','','${TOKEN}','11144477735','{}');`)).toThrow();
  expect(lastLine(sql(`select name from public.contacts where id='${id}'`))).toBe('Nome Atualizado');
  expect(()=>sql(`select public.fn_prontuario_address_merge('{"endereco":"Rua legada, 8"}','{"cep":"29000000"}');`)).toThrow();
  expect(json(`select public.fn_prontuario_address_merge('{"endereco":"Rua legada, 8"}','{"cep":""}');`)).toEqual({endereco:'Rua legada, 8'});
  expect(()=>sql(`select public.fn_prontuario_address_merge('{"endereco":"Rua A, 10, Apto 202, Centro, Vitória, ES, 29000000"}','{"logradouro":"Rua A","numero":"10","cidade":"Vitória","uf":"ES"}');`)).toThrow();
  expect(()=>sql(`select public.fn_prontuario_address_merge('{"endereco":"Rua A, 10, Apto 202, Vitória, ES","endereco_estruturado":{"logradouro":"Rua A","numero":"10","cidade":"Vitória","uf":"ES"}}','{"cep":"29000000"}');`)).toThrow();
 });
 it('conciliação explícita do texto com o endereço completo permite retomar',()=>{
  const current={endereco:'Rua A, 10, Sala 2, Vitória, ES',endereco_estruturado:{logradouro:'Rua A',numero:'10',cidade:'Vitória',uf:'ES'}};
  expect(json(`select public.fn_prontuario_address_merge('${JSON.stringify(current)}','{"complemento":"Sala 2"}');`)).toMatchObject({endereco:current.endereco,endereco_estruturado:{complemento:'Sala 2'}});
 });
 it('RPCs não estão disponíveis aos papéis públicos',()=>{
  for(const signature of ['fn_prontuario_create_contact_v2(uuid,uuid,text,date,text,text,uuid,uuid,text,jsonb)','fn_prontuario_patch_contact_v2(uuid,uuid,uuid,integer,timestamp with time zone,text,date,text,text,uuid,text,jsonb)','fn_prontuario_address_merge(jsonb,jsonb)'])
   for(const role of ['anon','authenticated'])expect(lastLine(sql(`select has_function_privilege('${role}','public.${signature}','EXECUTE')`))).toBe('f');
 });
});
