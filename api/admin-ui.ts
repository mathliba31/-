import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../lib/env';

/**
 * Shopify管理画面に埋め込まれる設定画面(campaign_eventsのCRUD UI)。
 * ビルドツールは使わず、App Bridge(CDN配信)+ Vanilla JSのみで構成する。
 * 認証はApp Bridgeのセッショントークン(JWT)をBearerとしてAPIへ渡し、
 * api/admin/events側でlib/shopifySessionAuth.tsが検証する。
 */
export default function handler(req: VercelRequest, res: VercelResponse) {
  const shop = typeof req.query.shop === 'string' && req.query.shop ? req.query.shop : env.shopifyShopDomain;

  res.setHeader('Content-Security-Policy', `frame-ancestors https://${shop} https://admin.shopify.com;`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(renderHtml(env.shopifyClientId));
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function renderHtml(apiKey: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ガチャ設定</title>
<meta name="shopify-api-key" content="${escapeHtmlAttr(apiKey)}" />
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic", sans-serif;
    color: #1a1a1a;
    background: #f6f6f7;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .lead { color: #616161; font-size: 13px; margin: 0 0 20px; }
  .card {
    background: #fff;
    border: 1px solid #e3e3e3;
    border-radius: 10px;
    padding: 20px;
    margin-bottom: 20px;
  }
  .card h2 { font-size: 15px; margin: 0 0 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #eee; vertical-align: top; }
  th { color: #616161; font-weight: 600; font-size: 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .badge--active { background: #d3f3d3; color: #12631f; }
  .badge--inactive { background: #eee; color: #666; }
  .row-actions button { margin-right: 6px; }
  form.event-form { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  form.event-form .full { grid-column: 1 / -1; }
  label { display: block; font-size: 12px; color: #444; margin-bottom: 4px; }
  input[type="text"], input[type="number"], input[type="datetime-local"] {
    width: 100%;
    padding: 8px;
    border: 1px solid #ccc;
    border-radius: 6px;
    font-size: 13px;
  }
  .checkbox-row { display: flex; align-items: center; gap: 6px; }
  .checkbox-row label { margin: 0; }
  button {
    cursor: pointer;
    border-radius: 6px;
    border: 1px solid #ccc;
    background: #fff;
    padding: 7px 14px;
    font-size: 13px;
  }
  button.primary { background: #008060; border-color: #008060; color: #fff; font-weight: 600; }
  button.danger { border-color: #d82c0d; color: #d82c0d; }
  .form-actions { grid-column: 1 / -1; display: flex; gap: 10px; margin-top: 4px; }
  .msg { font-size: 13px; margin: 10px 0 0; }
  .msg--error { color: #d82c0d; }
  .msg--ok { color: #12631f; }
  .muted { color: #888; }
  .hint { font-size: 12px; color: #888; margin-top: 4px; }
</style>
</head>
<body>
  <h1>ガチャ設定 — イベント期間・天井(確定枠)</h1>
  <p class="lead">
    イベント期間中だけ「N回引くと確定枠(天井)」が有効になります。有効なイベントが無い間は天井は発生しません。
    ここでの変更はデプロイ不要で即座に反映されます。
  </p>

  <div class="card">
    <h2 id="form-title">新しいイベントを作成</h2>
    <form class="event-form" id="event-form">
      <input type="hidden" id="event-id" value="" />
      <div>
        <label for="f-key">キー(半角英数字・アンダースコアのみ、Flow側で参照)</label>
        <input type="text" id="f-key" placeholder="summer_2026" required />
      </div>
      <div>
        <label for="f-name">表示名</label>
        <input type="text" id="f-name" placeholder="サマーガチャ2026" required />
      </div>
      <div>
        <label for="f-starts">開始日時</label>
        <input type="datetime-local" id="f-starts" required />
      </div>
      <div>
        <label for="f-ends">終了日時</label>
        <input type="datetime-local" id="f-ends" required />
      </div>
      <div>
        <label for="f-threshold">天井までの回数(N)</label>
        <input type="number" id="f-threshold" min="1" step="1" placeholder="未入力なら既定値を使用" />
      </div>
      <div class="checkbox-row" style="align-self: end;">
        <input type="checkbox" id="f-active" checked />
        <label for="f-active">有効</label>
      </div>
      <div class="form-actions">
        <button type="submit" class="primary" id="f-submit">作成する</button>
        <button type="button" id="f-cancel" hidden>編集をキャンセル</button>
      </div>
      <p class="msg full" id="f-msg"></p>
    </form>
  </div>

  <div class="card">
    <h2>イベント一覧</h2>
    <table>
      <thead>
        <tr>
          <th>状態</th>
          <th>キー</th>
          <th>表示名</th>
          <th>期間</th>
          <th>N</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="event-list">
        <tr><td colspan="6" class="muted">読み込み中...</td></tr>
      </tbody>
    </table>
  </div>

<script>
(function () {
  "use strict";

  function toLocalInputValue(iso) {
    var d = new Date(iso);
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function formatRange(startsAt, endsAt) {
    var f = function (iso) {
      var d = new Date(iso);
      return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " +
        String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    };
    return f(startsAt) + " 〜 " + f(endsAt);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function isCurrentlyActive(ev) {
    if (!ev.is_active) return false;
    var now = new Date();
    return now >= new Date(ev.starts_at) && now <= new Date(ev.ends_at);
  }

  async function authFetch(url, options) {
    var token = await window.shopify.idToken();
    var opts = options || {};
    var headers = Object.assign({ "Content-Type": "application/json", Authorization: "Bearer " + token }, opts.headers || {});
    return fetch(url, Object.assign({}, opts, { headers: headers }));
  }

  var els = {
    list: document.getElementById("event-list"),
    form: document.getElementById("event-form"),
    formTitle: document.getElementById("form-title"),
    id: document.getElementById("event-id"),
    key: document.getElementById("f-key"),
    name: document.getElementById("f-name"),
    starts: document.getElementById("f-starts"),
    ends: document.getElementById("f-ends"),
    threshold: document.getElementById("f-threshold"),
    active: document.getElementById("f-active"),
    submit: document.getElementById("f-submit"),
    cancel: document.getElementById("f-cancel"),
    msg: document.getElementById("f-msg"),
  };

  function resetForm() {
    els.id.value = "";
    els.form.reset();
    els.active.checked = true;
    els.formTitle.textContent = "新しいイベントを作成";
    els.submit.textContent = "作成する";
    els.cancel.hidden = true;
    els.msg.textContent = "";
    els.msg.className = "msg full";
  }

  function loadForEdit(ev) {
    els.id.value = ev.id;
    els.key.value = ev.key;
    els.name.value = ev.name;
    els.starts.value = toLocalInputValue(ev.starts_at);
    els.ends.value = toLocalInputValue(ev.ends_at);
    els.threshold.value = ev.pity_threshold === null ? "" : ev.pity_threshold;
    els.active.checked = ev.is_active;
    els.formTitle.textContent = "イベントを編集: " + ev.name;
    els.submit.textContent = "更新する";
    els.cancel.hidden = false;
    els.msg.textContent = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderList(events) {
    if (!events.length) {
      els.list.innerHTML = '<tr><td colspan="6" class="muted">イベントはまだありません</td></tr>';
      return;
    }
    els.list.innerHTML = events
      .map(function (ev) {
        var active = isCurrentlyActive(ev);
        var badge = active
          ? '<span class="badge badge--active">開催中</span>'
          : '<span class="badge badge--inactive">' + (ev.is_active ? "期間外" : "無効") + "</span>";
        var threshold = ev.pity_threshold === null ? '<span class="muted">既定値</span>' : ev.pity_threshold;
        return (
          "<tr>" +
          "<td>" + badge + "</td>" +
          "<td>" + escapeHtml(ev.key) + "</td>" +
          "<td>" + escapeHtml(ev.name) + "</td>" +
          "<td>" + formatRange(ev.starts_at, ev.ends_at) + "</td>" +
          "<td>" + threshold + "</td>" +
          '<td class="row-actions">' +
          '<button type="button" data-action="edit" data-id="' + ev.id + '">編集</button>' +
          '<button type="button" data-action="toggle" data-id="' + ev.id + '" data-active="' + ev.is_active + '">' +
          (ev.is_active ? "無効化" : "有効化") +
          "</button>" +
          '<button type="button" class="danger" data-action="delete" data-id="' + ev.id + '">削除</button>' +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  var currentEvents = [];

  function fetchEvents() {
    return authFetch("/api/admin/events")
      .then(function (res) {
        if (!res.ok) throw new Error("LIST_ERROR_" + res.status);
        return res.json();
      })
      .then(function (body) {
        currentEvents = body.events || [];
        renderList(currentEvents);
      })
      .catch(function () {
        els.list.innerHTML = '<tr><td colspan="6" class="msg msg--error">一覧の取得に失敗しました</td></tr>';
      });
  }

  els.list.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-action]");
    if (!btn) return;
    var id = btn.getAttribute("data-id");
    var action = btn.getAttribute("data-action");

    if (action === "edit") {
      var ev = currentEvents.find(function (x) { return String(x.id) === id; });
      if (ev) loadForEdit(ev);
      return;
    }

    if (action === "toggle") {
      var nextActive = btn.getAttribute("data-active") !== "true";
      authFetch("/api/admin/events/" + id, { method: "PATCH", body: JSON.stringify({ is_active: nextActive }) })
        .then(function (res) {
          if (!res.ok) throw new Error("TOGGLE_ERROR");
          return fetchEvents();
        })
        .catch(function () {
          alert("更新に失敗しました");
        });
      return;
    }

    if (action === "delete") {
      if (!confirm("このイベントを削除します。よろしいですか?")) return;
      authFetch("/api/admin/events/" + id, { method: "DELETE" })
        .then(function (res) {
          if (!res.ok && res.status !== 204) throw new Error("DELETE_ERROR");
          return fetchEvents();
        })
        .catch(function () {
          alert("削除に失敗しました");
        });
    }
  });

  els.cancel.addEventListener("click", resetForm);

  els.form.addEventListener("submit", function (e) {
    e.preventDefault();
    els.msg.textContent = "";
    els.msg.className = "msg full";

    var payload = {
      key: els.key.value.trim(),
      name: els.name.value.trim(),
      starts_at: els.starts.value ? new Date(els.starts.value).toISOString() : "",
      ends_at: els.ends.value ? new Date(els.ends.value).toISOString() : "",
      pity_threshold: els.threshold.value === "" ? null : Number(els.threshold.value),
      is_active: els.active.checked,
    };

    var id = els.id.value;
    var url = id ? "/api/admin/events/" + id : "/api/admin/events";
    var method = id ? "PATCH" : "POST";

    els.submit.disabled = true;
    authFetch(url, { method: method, body: JSON.stringify(payload) })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (result) {
        els.submit.disabled = false;
        if (!result.ok) {
          els.msg.textContent = "エラー: " + (result.body.error || "unknown");
          els.msg.className = "msg full msg--error";
          return;
        }
        els.msg.textContent = "保存しました";
        els.msg.className = "msg full msg--ok";
        resetForm();
        fetchEvents();
      })
      .catch(function () {
        els.submit.disabled = false;
        els.msg.textContent = "通信エラーが発生しました";
        els.msg.className = "msg full msg--error";
      });
  });

  fetchEvents();
})();
</script>
</body>
</html>`;
}
