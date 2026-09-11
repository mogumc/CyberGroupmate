<script>
  import { activeTab } from '../lib/stores.js';
  import { api } from '../lib/api.js';

  /** 各类型展示信息（key 与后端 CacheCategoryKey 对齐） */
  const CATEGORY_META = {
    photos: { label: '图片', desc: '入站图片缓存（超过媒体保留天数的会由定时清理处理）' },
    videos: { label: '视频', desc: '入站视频缓存' },
    documents: { label: '文档', desc: '入站文档缓存' },
    other: { label: '其他媒体', desc: '动画等其它媒体（含 qq/tg-converted 等转换子目录）' },
    root: { label: '散落文件', desc: 'Downloads 根目录直接写入的下载（如 onebot_* 文件）' },
    stickers: { label: '贴纸', desc: '贴纸为永久资源，默认白名单不参与清理' },
  };
  const STICKER_WARNING = '清理贴纸可能导致模型无法再发送这些贴纸，请谨慎操作';

  let stats = null;
  let loading = false;
  let cleaning = false;
  let notice = null;
  let selected = {};
  let wasActive = false;

  $: {
    const isActive = $activeTab === 'file-cache';
    if (isActive && !wasActive && !loading) {
      loadStats();
    }
    wasActive = isActive;
  }

  function showNotice(message, type = 'info') {
    notice = { message, type };
    clearTimeout(showNotice.timer);
    showNotice.timer = setTimeout(() => {
      notice = null;
    }, type === 'error' ? 8000 : 4000);
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let num = value;
    let idx = 0;
    while (num >= 1024 && idx < units.length - 1) {
      num /= 1024;
      idx += 1;
    }
    return `${num >= 10 || idx === 0 ? Math.round(num) : num.toFixed(1)} ${units[idx]}`;
  }

  async function loadStats() {
    loading = true;
    try {
      const res = await api('/downloads/cache');
      if (res.error) throw new Error(res.error);
      stats = res;
      // 默认勾选除贴纸外的全部；保留用户已有勾选，只补充新出现的类型
      const next = { ...selected };
      for (const cat of res.categories || []) {
        if (next[cat.key] === undefined) next[cat.key] = cat.key !== 'stickers';
      }
      selected = next;
    } catch (err) {
      showNotice('加载文件缓存失败: ' + err, 'error');
      stats = null;
    } finally {
      loading = false;
    }
  }

  async function cleanup() {
    const categories = (stats?.categories || []).map((cat) => cat.key).filter((key) => selected[key]);
    if (categories.length === 0) {
      showNotice('请先勾选要清理的类型', 'error');
      return;
    }
    const totalFiles = (stats?.categories || [])
      .filter((cat) => categories.includes(cat.key))
      .reduce((sum, cat) => sum + cat.files, 0);
    if (totalFiles === 0) {
      showNotice('选中的类型没有可清理的文件', 'info');
      return;
    }

    const lines = [`确定清理选中的 ${categories.length} 类缓存（共 ${totalFiles} 个文件）？`];
    if (categories.includes('stickers')) {
      lines.push('', `⚠ ${STICKER_WARNING}`);
    }
    if (!confirm(lines.join('\n'))) return;

    cleaning = true;
    try {
      const res = await api('/downloads/cleanup', {
        method: 'POST',
        body: { categories },
      });
      if (res.error) throw new Error(res.error);
      if (res.stats) stats = { ...stats, ...res.stats };
      const cleanedFiles = (res.deleted || []).reduce((sum, entry) => sum + entry.files, 0);
      const cleanedBytes = (res.deleted || []).reduce((sum, entry) => sum + entry.bytes, 0);
      const detail = (res.deleted || [])
        .filter((entry) => entry.files > 0)
        .map((entry) => `${CATEGORY_META[entry.key]?.label || entry.key} ${entry.files}`)
        .join('、');
      showNotice(
        cleanedFiles > 0
          ? `已清理 ${cleanedFiles} 个文件（${formatBytes(cleanedBytes)}）：${detail}`
          : '没有可清理的文件',
        'success',
      );
    } catch (err) {
      showNotice('清理失败: ' + err, 'error');
    } finally {
      cleaning = false;
    }
  }
</script>

<div class="card bg-base-100">
  <div class="card-body p-4 space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-xl font-bold">文件缓存</h2>
        <p class="text-sm text-base-content/70">
          模型下载与入站媒体的本地缓存（workspace/Downloads）。按类型勾选后主动清理；贴纸默认白名单保留。
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-ghost btn-sm" on:click={loadStats} disabled={loading || cleaning}>
          {loading ? '刷新中...' : '刷新'}
        </button>
        <button class="btn btn-error btn-sm" on:click={cleanup} disabled={loading || cleaning || !stats}>
          {cleaning ? '清理中...' : '清理选中项'}
        </button>
      </div>
    </div>

    {#if notice}
      <div class={`alert ${notice.type === 'error' ? 'alert-error' : notice.type === 'success' ? 'alert-success' : 'alert-info'}`}>
        <span>{notice.message}</span>
      </div>
    {/if}

    <div class="stats stats-vertical lg:stats-horizontal shadow-sm bg-base-200">
      <div class="stat py-3">
        <div class="stat-title">缓存文件总数</div>
        <div class="stat-value text-2xl">{stats?.totalFiles ?? 0}</div>
      </div>
      <div class="stat py-3">
        <div class="stat-title">占用空间</div>
        <div class="stat-value text-2xl">{formatBytes(stats?.totalBytes ?? 0)}</div>
      </div>
      <div class="stat py-3">
        <div class="stat-title">缓存目录</div>
        <div class="stat-value text-xs break-all">{stats?.dir || '-'}</div>
      </div>
    </div>

    {#if loading && !stats}
      <div class="text-sm text-base-content/60">正在加载缓存状态...</div>
    {:else if !stats}
      <div class="rounded-xl border border-dashed border-base-300 p-4 text-sm text-base-content/60">
        暂无缓存数据，点击「刷新」重试。
      </div>
    {:else}
      <div class="space-y-2">
        {#each stats.categories as cat}
          <label class="flex cursor-pointer items-start gap-3 rounded-xl border border-base-300 bg-base-200 p-3">
            <input
              type="checkbox"
              class="checkbox checkbox-sm mt-0.5"
              bind:checked={selected[cat.key]}
              disabled={cleaning}
            />
            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-semibold">{CATEGORY_META[cat.key]?.label || cat.key}</span>
                <span class="badge badge-outline badge-sm font-mono">{cat.key}</span>
                <span class="badge badge-ghost badge-sm">{cat.files} 个文件</span>
                <span class="badge badge-ghost badge-sm">{formatBytes(cat.bytes)}</span>
              </div>
              <div class="text-xs opacity-70">
                {CATEGORY_META[cat.key]?.desc || ''}
                {#if cat.key === 'stickers'}
                  <span class="text-warning font-semibold">⚠ {STICKER_WARNING}</span>
                {/if}
              </div>
            </div>
          </label>
        {/each}
      </div>
      <p class="text-xs text-base-content/60 leading-6">
        清理会删除磁盘文件并同步从缓存索引中移除；贴纸默认保留（勾选后才清理）。
        定时清理（媒体保留天数）仍会自动处理过期文件。
      </p>
    {/if}
  </div>
</div>
