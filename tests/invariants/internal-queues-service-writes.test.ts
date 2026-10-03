import { beforeAll, expect, it } from "vitest";
import { GOV_ORG, GOV_VIEWER, GOV_ADMIN, seedGov, sql, lastLine, countAs } from "./gov-helpers";

beforeAll(() => { seedGov(); });
for (const table of ["job_queue", "storage_redaction_queue"]) {
  it(`${table}: nenhum membro pode escrever diretamente; serviço pode operar`, () => {
    for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      expect(lastLine(sql(`select has_table_privilege('authenticated', 'public.${table}', '${privilege}');`))).toBe("f");
      expect(lastLine(sql(`select has_table_privilege('service_role', 'public.${table}', '${privilege}');`))).toBe("t");
    }
    for (const user of [GOV_VIEWER, GOV_ADMIN]) {
      const insert = table === "job_queue"
        ? `insert into public.job_queue (organization_id, kind) values ('${GOV_ORG}', 'watchdog')`
        : `insert into public.storage_redaction_queue (organization_id, bucket, object_path) values ('${GOV_ORG}', 'whatsapp-media', 'other-tenant/test')`;
      expect(() => sql(`set role authenticated; select set_config('request.jwt.claims', '{"sub":"${user}"}', false); ${insert};`)).toThrow(/permission denied/);
      expect(countAs(user, `select count(*) from public.${table} where organization_id <> '${GOV_ORG}';`)).toBe(0);
    }
    sql(`begin; set local role service_role;
      ${table === "job_queue"
        ? `insert into public.job_queue (organization_id, kind) values ('${GOV_ORG}', 'watchdog'); update public.job_queue set priority=101 where organization_id='${GOV_ORG}'; delete from public.job_queue where organization_id='${GOV_ORG}';`
        : `insert into public.storage_redaction_queue (organization_id, bucket, object_path) values ('${GOV_ORG}', 'whatsapp-media', 'synthetic/test'); update public.storage_redaction_queue set status='skipped' where organization_id='${GOV_ORG}'; delete from public.storage_redaction_queue where organization_id='${GOV_ORG}';`}
      rollback;`);
  });
}
