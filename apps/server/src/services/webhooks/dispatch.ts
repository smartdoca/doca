import { claimWebhookDeliveries, completeWebhookDelivery, enqueueWebhookDeliveries } from "@core/modules/automation/webhooks.js";
import { projectionErrorMessage } from "@core/modules/automation/jobs.js";
import type { DB } from "@db/index.js";
import type { WebhookDB } from "@db/webhook-database.js";
import { postWebhook, type WebhookPost, type WebhookResolve } from "./http.js";

/** Publish the outbox, then post outside the business transaction. */
export async function dispatchWebhooks(
  app: DB,
  db: WebhookDB,
  options: { post?: WebhookPost; resolve?: WebhookResolve; limit?: number } = {},
) {
  await enqueueWebhookDeliveries(app, db);
  const jobs = await claimWebhookDeliveries(db, options.limit ?? 8);
  await Promise.all(
    jobs.map(async (job) => {
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        for (const header of job.headers) headers[header.name] = header.value;
        const post = options.post ?? ((input) => postWebhook(input, options.resolve));
        const result = await post({
          url: job.url,
          body: job.body,
          headers,
        });
        await completeWebhookDelivery(db, job, {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          error:
            result.status >= 200 && result.status < 300
              ? undefined
              : `HTTP ${result.status}`,
        });
      } catch (error) {
        await completeWebhookDelivery(db, job, {
          ok: false,
          error: projectionErrorMessage(error),
        });
      }
    }),
  );
  return jobs.length;
}
