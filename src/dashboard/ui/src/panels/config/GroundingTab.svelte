<script>
  export let config;
  export let pwFocus;
  export let pwBlur;

  /**
   * UI 侧以字符串数组维护 key 列表；写回 config 时：
   * - ≥2 个 → config.grounding.pool（多 Key 轮询）
   * - 0/1 个 → config.grounding.apiKey（兼容旧配置）
   */
  let keys = [];
  /** 上一次写入 config 的快照，用于区分「外部变更」与「自己刚推上去的值」，避免空输入行被擦掉 */
  let lastPushed = null;

  $: {
    const fromConfig = config.grounding?.pool?.members?.length
      ? config.grounding.pool.members.map((m) => m.apiKey)
      : config.grounding?.apiKey
        ? [config.grounding.apiKey]
        : [];
    const sig = fromConfig.join("\u0001");
    if (sig !== lastPushed) {
      keys = fromConfig.length ? fromConfig : [""];
      lastPushed = sig;
    }
  }

  function pushKeys() {
    const nonEmpty = keys.map((k) => k.trim()).filter(Boolean);
    if (nonEmpty.length >= 2) {
      // 走 pool 时清空 api_key：否则保存后密钥会在配置文件里存两份，且两份会各自漂移
      config.grounding.apiKey = "";
      config.grounding.pool = {
        strategy: config.grounding.pool?.strategy ?? "round_robin",
        members: nonEmpty.map((apiKey) => ({ apiKey })),
      };
    } else {
      config.grounding.apiKey = nonEmpty[0] ?? "";
      config.grounding.pool = undefined;
    }
    lastPushed = nonEmpty.join("\u0001");
  }

  function addKey() {
    keys = [...keys, ""];
  }

  function removeKey(idx) {
    keys = keys.filter((_, i) => i !== idx);
    pushKeys();
  }
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-globe opacity-50 mr-1"></i> Grounding (联网事实查证)
</h3>
<p class="text-xs opacity-50 mb-3">
  在主 Agent 决策时并行查询真实世界信息，用于事实查证和知识补充。配置后将自动在 attend 阶段并行触发。
</p>

<div class="cfg-grid-2">
  <label class="cfg-field">
    <span class="cfg-label">搜索引擎</span>
    <select
      class="select select-xs select-bordered w-full"
      bind:value={config.grounding.provider}
    >
      <option value="google">Google (Gemini)</option>
      <option value="grok">Grok (xAI)</option>
      <option value="tavily">Tavily</option>
    </select>
  </label>

  <label class="cfg-field">
    <span class="cfg-label">Base URL <span class="opacity-40">(可选)</span></span>
    <input
      type="text"
      class="input input-xs input-bordered w-full"
      bind:value={config.grounding.baseUrl}
      placeholder={config.grounding.provider === 'grok'
        ? 'https://api.x.ai/v1'
        : config.grounding.provider === 'tavily'
          ? 'https://api.tavily.com'
          : '(Google 无需设置)'}
    />
  </label>

  {#if config.grounding.provider !== 'tavily'}
    <label class="cfg-field">
      <span class="cfg-label">模型 <span class="opacity-40">(可选)</span></span>
      <input
        type="text"
        class="input input-xs input-bordered w-full"
        bind:value={config.grounding.model}
        placeholder={config.grounding.provider === 'grok' ? 'grok-3-mini-fast' : 'gemini-2.0-flash-lite'}
      />
    </label>
  {/if}

  {#if config.grounding.pool}
    <label class="cfg-field">
      <span class="cfg-label">多 Key 调度策略</span>
      <select
        class="select select-xs select-bordered w-full"
        bind:value={config.grounding.pool.strategy}
      >
        <option value="round_robin">轮询 (round_robin)</option>
        <option value="least_pending">最少并发 (least_pending)</option>
        <option value="random">随机 (random)</option>
      </select>
    </label>
  {/if}
</div>

<div class="cfg-field mt-3">
  <span class="cfg-label">
    API Key
    {#if keys.length > 1}
      <span class="opacity-40">（{keys.length} 个，自动轮询）</span>
    {/if}
  </span>
  <div class="space-y-1">
    {#each keys as key, idx}
      <div class="flex items-center gap-1">
        <span class="text-xs opacity-40" style="width:1.5rem">{idx + 1}.</span>
        <input
          type="password"
          class="input input-xs input-bordered w-full"
          value={key}
          placeholder={idx === 0 ? '输入 API Key' : '再贴一个 Key（凑够 2 个即启用轮询）'}
          on:input={(e) => { keys[idx] = e.currentTarget.value; pushKeys(); }}
          on:focus={pwFocus}
          on:blur={pwBlur}
        />
        <button
          class="btn btn-xs btn-ghost btn-error"
          title="删除"
          disabled={keys.length <= 1}
          on:click={() => removeKey(idx)}
        >
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
    {/each}
  </div>
  <button class="btn btn-xs btn-outline btn-primary mt-2" on:click={addKey}>
    <i class="fa-solid fa-plus"></i> 添加密钥
  </button>
</div>

<div class="mt-3 p-2 rounded bg-base-200 text-xs opacity-60">
  <i class="fa-solid fa-circle-info mr-1"></i>
  {#if config.grounding.provider === 'google'}
    使用 <b>Gemini API</b> 的原生 Google Search Grounding 工具。需在 <a href="https://aistudio.google.com/apikey" target="_blank" class="link">AI Studio</a> 获取 API Key。
  {:else if config.grounding.provider === 'grok'}
    使用 <b>xAI Grok</b> 的 Web Search 工具（Responses API）。需在 <a href="https://console.x.ai" target="_blank" class="link">xAI Console</a> 获取 API Key。
  {:else}
    使用 <b>Tavily</b> 的 Search API（纯检索，无 LLM 综合）。需在 <a href="https://app.tavily.com/home" target="_blank" class="link">Tavily 控制台</a> 获取 API Key，免费额度按月重置，可多申请几个 Key 轮询。
  {/if}
</div>

{#if keys.length > 1}
  <div class="mt-2 p-2 rounded bg-base-200 text-xs opacity-60">
    <i class="fa-solid fa-arrows-rotate mr-1"></i>
    多 Key 已启用：按上方策略轮询；命中 <b>429 / quota</b> 的 Key 会短暂冷却，命中 <b>401 / 403</b> 的 Key 会被禁用，本次请求自动切到下一个 Key 重试。
  </div>
{/if}
