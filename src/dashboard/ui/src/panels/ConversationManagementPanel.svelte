<script>
  /**
   * ConversationManagementPanel — 会话管理（移除不需要的对话）
   *
   * 每个会话一行，行尾一个「最终确认删除」图标；点开弹窗必须选/填删除理由。
   * 删除是级联且不可逆的：消息 / 话题 / 运行时实例 / session 文件 / 群组画像都会被清掉；
   * 记忆（facts / 画像 / digest）不动。
   *
   * 审计卡片支持三档清理：单条删除、清空早于 N 天、全部清空。
   * 全部清空需输入确认词 —— 审计是「谁删了什么」的唯一凭据，删掉就再也查不回来。
   */
  import { activeTab } from '../lib/stores.js';
  import { api } from '../lib/api.js';
  import { platformLabel } from '../lib/utils.js';

  const PURGE_CONFIRM_WORD = '清空';

  let loading = false;
  let error = '';
  let notice = '';
  let conversations = [];
  let audit = [];
  let auditTotal = 0;
  let presets = [];

  let deleting = null;
  let reasonCode = '';
  let reasonText = '';
  let submitting = false;
  let deleteModal;

  let purging = false;
  let purgeBeforeDays = 7;
  let purgeAllWord = '';
  let purgeAllModal;

  $: if ($activeTab === 'conversation-management') load();

  async function load() {
    loading = true;
    error = '';
    try {
      const data = await api('/conversation-management');
      conversations = data.conversations ?? [];
      audit = data.audit ?? [];
      auditTotal = data.auditTotal ?? audit.length;
      presets = data.presets ?? [];
      if (!reasonCode) reasonCode = presets[0]?.code ?? '';
    } catch (err) {
      error = String(err);
    } finally {
      loading = false;
    }
  }

  function openDelete(conv) {
    deleting = conv;
    reasonCode = presets[0]?.code ?? '';
    reasonText = '';
    error = '';
    deleteModal?.showModal();
  }

  function closeDelete() {
    deleteModal?.close();
    deleting = null;
  }

  $: needsText = reasonCode === 'other' && reasonText.trim().length === 0;

  async function confirmDelete() {
    if (!deleting || submitting || needsText) return;
    submitting = true;
    error = '';
    try {
      const res = await api(`/memory/chat/${encodeURIComponent(deleting.chatId)}`, {
        method: 'DELETE',
        body: { reasonCode, reasonText: reasonText.trim(), chatTitle: deleting.chatTitle },
      });
      if (!res.ok) {
        error = res.error || '删除失败';
        return;
      }
      deleteModal?.close();
      deleting = null;
      await load();
      // 部分删除要显式提示，否则用户以为清干净了
      const failures = res.record?.failures ?? [];
      if (failures.length > 0) {
        error = `会话已从列表移除，但有 ${failures.length} 步清理失败，请查看审计：${failures.join('；')}`;
      }
    } catch (err) {
      error = String(err);
    } finally {
      submitting = false;
    }
  }

  // ─── 审计清理 ───

  async function purgeOne(rec) {
    if (purging) return;
    purging = true;
    error = '';
    try {
      const res = await api(`/conversation-management/audit/${encodeURIComponent(rec.key)}`, { method: 'DELETE' });
      if (!res.ok) {
        error = res.error || '删除审计失败';
        return;
      }
      await load();
    } catch (err) {
      error = String(err);
    } finally {
      purging = false;
    }
  }

  async function purgeOlderThan() {
    if (purging) return;
    const days = Number(purgeBeforeDays);
    if (!Number.isFinite(days) || days <= 0) {
      error = '请输入正数天数';
      return;
    }
    const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    if (!confirm(`确定清空 ${days} 天前的审计记录？此操作不可恢复。`)) return;
    purging = true;
    error = '';
    try {
      const res = await api(`/conversation-management/audit?before=${encodeURIComponent(before)}`, { method: 'DELETE' });
      if (!res.ok) {
        error = res.error || '清理审计失败';
        return;
      }
      notice = res.removed > 0 ? `已清理 ${res.removed} 条审计记录` : '没有符合条件的审计记录';
      await load();
    } catch (err) {
      error = String(err);
    } finally {
      purging = false;
    }
  }

  function openPurgeAll() {
    purgeAllWord = '';
    error = '';
    purgeAllModal?.showModal();
  }

  $: purgeAllReady = purgeAllWord.trim() === PURGE_CONFIRM_WORD;

  async function confirmPurgeAll() {
    if (purging || !purgeAllReady) return;
    purging = true;
    error = '';
    try {
      const res = await api('/conversation-management/audit', { method: 'DELETE' });
      if (!res.ok) {
        error = res.error || '清空审计失败';
        return;
      }
      purgeAllModal?.close();
      notice = res.removed > 0 ? `已清空 ${res.removed} 条审计记录` : '审计已经是空的';
      await load();
    } catch (err) {
      error = String(err);
    } finally {
      purging = false;
    }
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
  }

  function presetLabel(code) {
    return presets.find((p) => p.code === code)?.label ?? code;
  }
</script>

{#if error}
  <div class="alert alert-error mb-3 py-2 text-sm">
    <span>{error}</span>
  </div>
{/if}

{#if notice}
  <div class="alert alert-info mb-3 py-2 text-sm">
    <span>{notice}</span>
  </div>
{/if}

<div class="card bg-base-200 mb-4">
  <div class="card-body p-4">
    <div class="flex items-center justify-between mb-3">
      <h3 class="card-title text-base mb-0">会话管理</h3>
      <button class="btn btn-sm btn-ghost" onclick={load} disabled={loading}>
        {loading ? '加载中…' : '刷新'}
      </button>
    </div>

    <p class="text-xs opacity-70 mb-3">
      删除会级联清理该会话的消息、话题、运行时实例与 session 文件；记忆（事实 / 画像 / digest）不受影响。
      删除不可逆，必须给出理由。
    </p>

    {#if conversations.length === 0}
      <div class="text-sm opacity-60">{loading ? '加载中…' : '暂无会话'}</div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr>
              <th>平台</th>
              <th>会话</th>
              <th class="text-right">消息</th>
              <th class="text-right">话题</th>
              <th>最后活跃</th>
              <th class="w-12"></th>
            </tr>
          </thead>
          <tbody>
            {#each conversations as conv (conv.chatId)}
              <tr>
                <td>
                  <span class="badge badge-ghost badge-sm">{platformLabel(conv.platform)}</span>
                  {#if conv.isDirectMessage}<span class="badge badge-sm">私聊</span>{/if}
                  {#if conv.active}<span class="badge badge-success badge-sm">活跃</span>{/if}
                </td>
                <td>
                  <div class="font-medium">{conv.chatTitle || '（未命名）'}</div>
                  <div class="text-xs opacity-60 font-mono">{conv.chatId}</div>
                </td>
                <td class="text-right">{conv.messageCount}</td>
                <td class="text-right">{conv.topicCount}</td>
                <td class="text-xs opacity-70">{fmtTime(conv.lastMessageAt)}</td>
                <td>
                  <button
                    class="btn btn-xs btn-ghost text-error"
                    title="最终确认删除"
                    onclick={() => openDelete(conv)}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 32 32" fill="currentColor">
                      <path d="M12 4h8v2h-8zM6 8h20v2H6zm2 4h16v14a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2zm4 3v9h2v-9zm4 0v9h2v-9z" />
                    </svg>
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>

{#if audit.length > 0}
  <div class="card bg-base-200">
    <div class="card-body p-4">
      <h3 class="card-title text-base mb-2">
        删除审计
        <span class="text-xs font-normal opacity-60">共 {auditTotal} 条{auditTotal > audit.length ? `，显示最近 ${audit.length} 条` : ''}</span>
      </h3>

      <div class="flex flex-wrap items-center gap-2 mb-3">
        <label class="text-xs opacity-70">清理早于</label>
        <input
          type="number"
          min="1"
          class="input input-bordered input-xs w-20"
          bind:value={purgeBeforeDays}
        />
        <span class="text-xs opacity-70">天</span>
        <button class="btn btn-xs btn-ghost" onclick={purgeOlderThan} disabled={purging}>清理</button>
        <div class="flex-1"></div>
        <button class="btn btn-xs btn-error" onclick={openPurgeAll} disabled={purging || audit.length === 0}>
          清空全部
        </button>
      </div>

      <div class="overflow-x-auto">
        <table class="table table-xs">
          <thead>
            <tr>
              <th>时间</th>
              <th>会话</th>
              <th>理由</th>
              <th class="text-right">消息</th>
              <th class="text-right">话题</th>
              <th class="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {#each audit as rec (rec.key ?? rec.chatId + rec.deletedAt)}
              <tr>
                <td class="text-xs whitespace-nowrap">{fmtTime(rec.deletedAt)}</td>
                <td>
                  <div>{rec.chatTitle || rec.chatId}</div>
                  <div class="text-xs opacity-60 font-mono">{rec.chatId}</div>
                </td>
                <td class="text-xs">
                  {presetLabel(rec.reasonCode)}
                  {#if rec.reasonText}<span class="opacity-70">：{rec.reasonText}</span>{/if}
                  {#if rec.failures?.length}
                    <span class="badge badge-warning badge-xs ml-1" title={rec.failures.join('；')}>部分失败</span>
                  {/if}
                </td>
                <td class="text-right">{rec.deleted?.messages ?? 0}</td>
                <td class="text-right">{rec.deleted?.topics ?? 0}</td>
                <td>
                  <button
                    class="btn btn-xs btn-ghost text-error"
                    title="删除此条审计"
                    onclick={() => purgeOne(rec)}
                    disabled={purging}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 32 32" fill="currentColor">
                      <path d="M12 4h8v2h-8zM6 8h20v2H6zm2 4h16v14a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2zm4 3v9h2v-9zm4 0v9h2v-9z" />
                    </svg>
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>
{/if}

<dialog bind:this={purgeAllModal} class="modal">
  <div class="modal-box">
    <h3 class="font-bold text-lg text-error">清空全部审计</h3>
    <p class="py-2 text-sm">
      将删除全部 <span class="font-medium">{auditTotal}</span> 条删除审计记录。
      <span class="text-error">此操作不可逆，审计记录将不再保留。</span>
    </p>
    <p class="text-xs opacity-70 mb-3">
      审计是「谁在什么时候删了什么」的唯一凭据，清空后无法恢复、也无从追溯。
    </p>

    <label class="label py-1">
      <span class="label-text text-sm">请输入「{PURGE_CONFIRM_WORD}」以确认</span>
    </label>
    <input
      class="input input-bordered input-sm w-full"
      placeholder={PURGE_CONFIRM_WORD}
      bind:value={purgeAllWord}
    />

    <div class="modal-action">
      <button class="btn btn-sm" onclick={() => purgeAllModal?.close()} disabled={purging}>取消</button>
      <button class="btn btn-sm btn-error" onclick={confirmPurgeAll} disabled={purging || !purgeAllReady}>
        {purging ? '清空中…' : '确认清空'}
      </button>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop"><button>close</button></form>
</dialog>

<dialog bind:this={deleteModal} class="modal">
  <div class="modal-box">
    <h3 class="font-bold text-lg text-error">最终确认删除</h3>
    {#if deleting}
      <p class="py-2 text-sm">
        即将移除会话 <span class="font-medium">{deleting.chatTitle || deleting.chatId}</span>
        {#if deleting.chatTitle}<span class="opacity-60 font-mono text-xs">（{deleting.chatId}）</span>{/if}
      </p>
      <p class="text-xs opacity-70 mb-3">
        将删除其 {deleting.messageCount} 条消息与 {deleting.topicCount} 个话题，并清理运行时实例与 session 文件。
        <span class="text-error">此操作不可逆。</span>
      </p>
    {/if}

    <label class="label py-1"><span class="label-text text-sm">删除理由（必填）</span></label>
    <select class="select select-bordered select-sm w-full" bind:value={reasonCode}>
      {#each presets as preset}
        <option value={preset.code}>{preset.label}</option>
      {/each}
    </select>
    {#if presets.find((p) => p.code === reasonCode)?.hint}
      <p class="text-xs opacity-60 mt-1">{presets.find((p) => p.code === reasonCode).hint}</p>
    {/if}

    <textarea
      class="textarea textarea-bordered w-full mt-2 text-sm"
      rows="2"
      placeholder={reasonCode === 'other' ? '请填写说明（必填）' : '补充说明（可选）'}
      bind:value={reasonText}
    ></textarea>

    <div class="modal-action">
      <button class="btn btn-sm" onclick={closeDelete} disabled={submitting}>取消</button>
      <button class="btn btn-sm btn-error" onclick={confirmDelete} disabled={submitting || needsText}>
        {submitting ? '删除中…' : '确认删除'}
      </button>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop"><button>close</button></form>
</dialog>
