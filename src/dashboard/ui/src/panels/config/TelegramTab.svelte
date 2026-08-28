<script>
  export let config;
  export let telegramEnabled = false;
  export let pwFocus;
  export let pwBlur;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-paper-plane opacity-50 mr-1"></i> Telegram 设置
</h3>
<label class="cfg-check mb-2">
  <input
    type="checkbox"
    class="toggle toggle-sm"
    bind:checked={telegramEnabled}
  />
  <span class="text-sm font-medium">启用 Telegram Adapter</span>
</label>
{#if !telegramEnabled}
  <p class="text-xs opacity-40 italic mb-3">未启用，设置不会保存到配置文件。</p>
{/if}
<div class:opacity-40={!telegramEnabled} class:pointer-events-none={!telegramEnabled}>
  <p class="text-xs opacity-50 mb-3">连接参数和发送行为。</p>
  <div class="cfg-grid-2">
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> 连接模式</span
      >
      <select
        class="select select-xs select-bordered w-full"
        bind:value={config.telegram.mode}
      >
        <option value="bot">bot (MTProto)</option
        ><option value="userbot">userbot (MTProto)</option
        ><option value="botapi">botapi (Bot API over HTTP)</option>
      </select></label
    >
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> Bot Token</span
      >
      <input
        type="password"
        class="input input-xs input-bordered w-full"
        bind:value={config.telegram.botToken}
        on:focus={pwFocus}
        on:blur={pwBlur}
      /></label
    >
    {#if config.telegram.mode === 'botapi'}
      <label class="cfg-field"
        ><span class="cfg-label"
          ><i class="fa-solid fa-rotate-right restart-icon"></i> API 根地址 (反代)</span
        >
        <input
          type="text"
          class="input input-xs input-bordered w-full"
          bind:value={config.telegram.apiBaseUrl}
          placeholder="https://api.telegram.org（可填反向代理地址）"
        /></label
      >
      <label class="cfg-field"
        ><span class="cfg-label"
          ><i class="fa-solid fa-rotate-right restart-icon"></i> 长轮询超时 (秒)</span
        >
        <input
          type="number"
          min="0"
          max="50"
          class="input input-xs input-bordered w-full"
          bind:value={config.telegram.pollTimeoutSec}
          placeholder="30"
        /></label
      >
      <p class="text-xs opacity-50 col-span-2 mb-1">
        botapi 模式走标准 Bot API over HTTP（getUpdates 长轮询），无需 API ID / API Hash。
        API 根地址可指向反向代理的 bot.telegram.org（需同时转发 /bot&lt;token&gt;/* 与 /file/bot&lt;token&gt;/*）。
      </p>
    {:else}
      <label class="cfg-field"
        ><span class="cfg-label"
          ><i class="fa-solid fa-rotate-right restart-icon"></i> API ID</span
        >
        <input
          type="text"
          class="input input-xs input-bordered w-full"
          bind:value={config.telegram.apiId}
        /></label
      >
      <label class="cfg-field"
        ><span class="cfg-label"
          ><i class="fa-solid fa-rotate-right restart-icon"></i> API Hash</span
        >
        <input
          type="password"
          class="input input-xs input-bordered w-full"
          bind:value={config.telegram.apiHash}
          on:focus={pwFocus}
          on:blur={pwBlur}
        /></label
      >
      <label class="cfg-field col-span-2"
        ><span class="cfg-label"
          ><i class="fa-solid fa-rotate-right restart-icon"></i> 手机号 (userbot)</span
        >
        <input
          type="text"
          class="input input-xs input-bordered w-full"
          bind:value={config.telegram.phone}
          placeholder="+86..."
        /></label
      >
    {/if}
  </div>
  <div class="divider text-xs opacity-50 my-3">拟人化发送延迟</div>
  <label class="cfg-check mb-2">
    <input
      type="checkbox"
      class="toggle toggle-xs"
      bind:checked={config.telegram.humanizedDelay.enabled}
    />
    <span>启用拟人化延迟</span>
  </label>
  {#if config.telegram.humanizedDelay.enabled}
    <div class="cfg-grid-3">
      <label class="cfg-field"
        ><span class="cfg-label">每字符 ms</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.telegram.humanizedDelay.msPerChar}
        /></label
      >
      <label class="cfg-field"
        ><span class="cfg-label">最小 ms</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.telegram.humanizedDelay.minDelay}
        /></label
      >
      <label class="cfg-field"
        ><span class="cfg-label">最大 ms</span>
        <input
          type="number"
          class="input input-xs input-bordered w-full"
          bind:value={config.telegram.humanizedDelay.maxDelay}
        /></label
      >
    </div>
  {/if}
</div>
