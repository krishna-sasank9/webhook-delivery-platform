import { useEffect, useState } from 'react';

import { api, type Webhook } from '../api';

/**
 * A minimal producer so the dashboard can drive its own traffic: pick a
 * registered webhook, fire an event, watch it flow through the queue. Handy for
 * demos and for eyeballing the whole pipeline without curl.
 */
export function EnqueuePanel({
  tenant,
  onEnqueued,
}: {
  tenant: string;
  onEnqueued: () => void;
}) {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [webhookId, setWebhookId] = useState('');
  const [eventType, setEventType] = useState('order.created');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listWebhooks(tenant)
      .then((r) => {
        setWebhooks(r.webhooks);
        setWebhookId((prev) => prev || r.webhooks[0]?.id || '');
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [tenant]);

  async function send() {
    setError(null);
    try {
      await api.enqueueEvent({
        tenant,
        webhookId,
        eventType,
        payload: { at: new Date().toISOString(), n: Math.floor(Math.random() * 1000) },
      });
      onEnqueued();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <h2>Send test event</h2>
        <div className="spacer" />
      </div>
      <div style={{ padding: 16 }}>
        {webhooks.length === 0 ? (
          <div className="dim">
            No webhooks registered for <b>{tenant}</b>. Register one via{' '}
            <span className="mono">POST /webhooks</span> first.
          </div>
        ) : (
          <div className="enqueue">
            <select value={webhookId} onChange={(e) => setWebhookId(e.target.value)}>
              {webhooks.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.id.slice(0, 8)} — {w.url}
                </option>
              ))}
            </select>
            <input
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              placeholder="event type"
              style={{ width: 160 }}
            />
            <button className="primary" onClick={send} disabled={!webhookId}>
              Enqueue
            </button>
          </div>
        )}
        {error && <div className="error-banner" style={{ marginTop: 12 }}>{error}</div>}
      </div>
    </div>
  );
}
