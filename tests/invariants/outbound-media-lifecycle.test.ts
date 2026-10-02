import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GOV_ORG, GOV_CONV_UNASSIGNED, GOV_CONTACT_1, GOV_SESSION, seedGov, sql, lastLine } from "./gov-helpers";

const OTHER_ORG = "cccccccc-0300-4000-8000-000000000001";
const path = `${GOV_ORG}/${GOV_CONV_UNASSIGNED}/out-security-test`;
const reserve = (suffix: string, bytes = 52428800) => `select public.fn_reserve_outbound_media('${GOV_ORG}','${GOV_CONV_UNASSIGNED}','${path}${suffix}',${bytes});`;
const message = (suffix: string) => `insert into public.messages(organization_id,conversation_id,contact_id,channel_session_id,type,direction,status,media_storage_path)
values('${GOV_ORG}','${GOV_CONV_UNASSIGNED}','${GOV_CONTACT_1}','${GOV_SESSION}','image','outbound','queued','${path}${suffix}');`;
beforeAll(() => {
  seedGov();
  sql(`insert into public.organizations(id,slug,legal_name,display_name) values('${OTHER_ORG}','media-security-other','Synthetic','Synthetic') on conflict do nothing;`);
});
beforeEach(() => sql(`delete from public.outbound_media_uploads where object_path like '${path}%';`));

describe("outbound media lifecycle", () => {
  it("reserves at most 100 MiB even across different paths", () => {
    expect(lastLine(sql("set role service_role; " + reserve("1")))).toBe("t");
    expect(lastLine(sql(reserve("2")))).toBe("t");
    expect(lastLine(sql(reserve("3", 1)))).toBe("f");
  });
  it("rejects a conversation outside the supplied tenant", () => {
    expect(() => sql(`select public.fn_reserve_outbound_media('${OTHER_ORG}','${GOV_CONV_UNASSIGNED}','${OTHER_ORG}/${GOV_CONV_UNASSIGNED}/out-test',1);`)).toThrow();
  });
  it("anon and authenticated cannot reserve, claim or alter lifecycle rows", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const statement of [reserve("x", 1), "select * from public.fn_claim_expired_outbound_media(1);", "delete from public.outbound_media_uploads;", "select * from public.outbound_media_uploads;"]) {
        expect(() => sql(`set role ${role}; ${statement}`)).toThrow();
      }
    }
  });
  it("message attachment protects the object from expiry cleanup", () => {
    sql(reserve("attached", 1) + message("attached"));
    expect(lastLine(sql(`select state from public.outbound_media_uploads where object_path='${path}attached';`))).toBe("attached");
    sql(`update public.outbound_media_uploads set expires_at=now()-interval '1 day' where object_path='${path}attached';`);
    expect(lastLine(sql(`select count(*) from public.fn_claim_expired_outbound_media(200) where object_path='${path}attached';`))).toBe("0");
  });
  it("expired upload cannot race cleanup by becoming a message", () => {
    sql(reserve("expired", 1));
    sql(`update public.outbound_media_uploads set expires_at=now()-interval '1 day' where object_path='${path}expired';`);
    expect(() => sql(message("expired"))).toThrow();
    expect(lastLine(sql(`select count(*) from public.fn_claim_expired_outbound_media(200) where object_path='${path}expired';`))).toBe("1");
    expect(() => sql(message("expired"))).toThrow();
    expect(lastLine(sql(`select count(*) from public.fn_claim_expired_outbound_media(200) where object_path='${path}expired';`))).toBe("0");
  });
  it("quota remains charged until storage deletion succeeds", () => {
    sql(reserve("deleting1") + reserve("deleting2"));
    sql(`update public.outbound_media_uploads set state='deleting' where object_path like '${path}%';`);
    expect(lastLine(sql(reserve("more", 1)))).toBe("f");
    sql(`update public.outbound_media_uploads set state='deleted' where object_path like '${path}%';`);
    expect(lastLine(sql(reserve("more", 1)))).toBe("t");
  });
});
