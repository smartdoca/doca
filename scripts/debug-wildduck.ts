import { createHttpWildduck } from "../apps/server/src/adapters/wildduck-http.js";

const endpoint = process.env.WILDDUCK_ENDPOINT || "http://127.0.0.1:18080";
const token = process.env.WILDDUCK_TOKEN || "doca-local-wildduck-token";

const client = createHttpWildduck({
  enabled: true,
  endpoint,
  domain: "heyphp.com",
  mode: "independent",
  maxMailboxes: 10,
  username: "",
  token,
});

async function main() {
  console.log("testConnection", await client.testConnection());
  await client.ensureDomain("heyphp.com");
  await client.createAccount({
    name: "ada@heyphp.com",
    address: "ada@heyphp.com",
    secret: "AdaSecret123456",
  });
  await client.createAccount({
    name: "bob@heyphp.com",
    address: "bob@heyphp.com",
    secret: "BobSecret123456",
  });
  const folders = await client.listFolders("ada@heyphp.com");
  console.log("folders", folders.map((item) => `${item.role}:${item.name}:${item.id}`).join(", "));
  const sent = await client.sendMessage("ada@heyphp.com", {
    to: ["bob@heyphp.com"],
    subject: "Doca live send",
    text: "Hello from the WildDuck adapter.",
    html: "<p><strong>Hello</strong> from the WildDuck adapter.</p>",
  });
  console.log("sent", sent.id, sent.folder, sent.subject);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const bobInbox = (await client.listFolders("bob@heyphp.com")).find((item) => item.role === "inbox");
  const page = await client.listMessages("bob@heyphp.com", { folderId: bobInbox?.id });
  console.log("bob inbox", page.total, page.items.map((item) => item.subject));
  const first = page.items[0];
  if (!first) throw new Error("Bob did not receive the message");
  const detail = await client.getMessage("bob@heyphp.com", first.id);
  console.log("bob read", detail.subject, detail.html.slice(0, 80), "unread", detail.unread);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
