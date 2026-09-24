import { expect, it } from "vitest";
import { uniqueOnlineUsers } from "../apps/web/src/features/documents/online-users.js";

it("counts people rather than sessions, preserving first-seen order", () => {
  const users = [
    { id: "a", display_name: "甲", sessionId: "a-tab-1" },
    { id: "b", display_name: "乙", sessionId: "b-tab-1" },
    { id: "a", display_name: "甲改名", sessionId: "a-tab-2" },
  ];
  expect(uniqueOnlineUsers(users)).toEqual([users[2], users[1]]);
  expect(users).toHaveLength(3);
  expect(uniqueOnlineUsers([])).toEqual([]);
});
