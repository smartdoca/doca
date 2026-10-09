import { createServer } from "node:http";
import { expect, it } from "vitest";
import {
  createStorage,
  storageConfigForProfile,
  storageRuntime,
} from "@server/adapters/storage.js";
import { objectKey } from "@server/services/storage-policy.js";

it("uses a configured HTTP endpoint for signed path-style S3 uploads, downloads and deletes", async () => {
  const requests: { method: string; path: string; authorization: string }[] =
    [];
  const content = Buffer.from("isolated HTTP storage fixture");
  let uploaded: Buffer | undefined;
  const server = createServer(async (request, response) => {
    requests.push({
      method: request.method!,
      path: request.url!,
      authorization: request.headers.authorization ?? "",
    });
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      uploaded = Buffer.concat(chunks);
      response.end();
    } else if (request.method === "GET") {
      response.setHeader("Content-Length", content.length);
      response.end(content);
    } else {
      response.statusCode = 204;
      response.end();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const runtime = storageRuntime({
      DOCA_FILE_STORE_ID: "cloud",
      DOCA_FILE_STORES_JSON: JSON.stringify({
        version: 1,
        stores: {
          cloud: {
            provider: "s3",
            bucket: "doca-test",
            region: "us-east-1",
            endpoint,
            forcePathStyle: true,
            credentials: {
              accessKeyId: "isolated-test-access",
              secretAccessKey: "isolated-test-secret",
            },
          },
        },
      }),
    });
    const config = storageConfigForProfile(runtime, { id: "cloud" });
    const key = objectKey(
      "5c9e3caa-3a6e-4eb6-900b-0f45692627c4",
      "application/octet-stream",
    );
    const storage = createStorage(runtime);
    await storage.put(
      config,
      key,
      content,
      "application/octet-stream",
      "test.bin",
    );
    expect(uploaded).toEqual(content);
    expect(await storage.read(config, key)).toEqual(content);
    await storage.remove(config, key);
    expect(requests.map((request) => request.method)).toEqual([
      "PUT",
      "GET",
      "DELETE",
    ]);
    for (const request of requests) {
      expect(request.path.split("?")[0]).toBe(`/doca-test/${key}`);
      expect(request.authorization).toContain("AWS4-HMAC-SHA256");
      expect(request.authorization).toContain(
        "Credential=isolated-test-access/",
      );
      expect(request.authorization).toContain("/us-east-1/s3/aws4_request");
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
