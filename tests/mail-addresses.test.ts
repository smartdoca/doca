import { expect, it } from "vitest";
import {
  independentLocalPart,
  mailboxAddress,
  parseAddresses,
  validDomain,
  validLocalPart,
} from "../packages/core/src/modules/mail/addresses.js";
import {
  defaultMailSettings,
  mailConnectionChanged,
  parseMailSettings,
} from "../packages/core/src/modules/mail/settings.js";

it("normalizes mailbox local parts and domains", () => {
  expect(validLocalPart("support")).toBe(true);
  expect(validLocalPart("User.Name")).toBe(true);
  expect(validLocalPart("-bad")).toBe(false);
  expect(validDomain("heyphp.com")).toBe(true);
  expect(validDomain("mail")).toBe(false);
  expect(mailboxAddress("Ops", "HeyPHP.com")).toBe("ops@heyphp.com");
  expect(parseAddresses("a@heyphp.com, b@heyphp.com;c@heyphp.com")).toEqual([
    "a@heyphp.com",
    "b@heyphp.com",
    "c@heyphp.com",
  ]);
  expect(
    independentLocalPart({
      id: "11111111-1111-4111-8111-111111111111",
      login: "Alice",
      public_id: "alice",
    }),
  ).toBe("alice");
});

it("parses mail settings with a masked token for admins", () => {
  const config = parseMailSettings(
    JSON.stringify({
      enabled: true,
      endpoint: "https://mail.heyphp.com",
      domain: "HeyPHP.com",
      mode: "independent",
      maxMailboxes: 5,
      username: "admin",
      token: "  secret  ",
    }),
  );
  expect(config.domain).toBe("heyphp.com");
  expect(config.mode).toBe("independent");
  expect(config.maxMailboxes).toBe(5);
  expect(config.token).toBe("secret");
});

it("treats external-only mail updates as unchanged WildDuck connection", () => {
  const previous = parseMailSettings(
    JSON.stringify({
      ...defaultMailSettings,
      enabled: true,
      endpoint: "https://mail.heyphp.com",
      domain: "heyphp.com",
      token: "",
    }),
  );
  expect(
    mailConnectionChanged(previous, {
      ...previous,
      external: { ...previous.external, enabled: true },
    }),
  ).toBe(false);
  expect(
    mailConnectionChanged(previous, {
      ...previous,
      endpoint: "https://mail.example.com",
    }),
  ).toBe(true);
});
