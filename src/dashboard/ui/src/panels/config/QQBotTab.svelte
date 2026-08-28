<script>
  export let config;
  export let qqbotEnabled = false;
  export let pwFocus;
  export let pwBlur;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-robot opacity-50 mr-1"></i> QQ 官方机器人设置
</h3>
<label class="cfg-check mb-2">
  <input
    type="checkbox"
    class="toggle toggle-sm"
    bind:checked={qqbotEnabled}
  />
  <span class="text-sm font-medium">启用 QQ 官方 Bot Adapter</span>
</label>
{#if !qqbotEnabled}
  <p class="text-xs opacity-40 italic mb-3">未启用，设置不会保存到配置文件。</p>
{/if}
<div class:opacity-40={!qqbotEnabled} class:pointer-events-none={!qqbotEnabled}>
  <p class="text-xs opacity-50 mb-3">
    独立 adapter，与 QQ / OneBot (NapCat) 完全独立、可同时启用。凭据来自
    <a class="link link-hover" href="https://q.qq.com" target="_blank" rel="noreferrer">q.qq.com 开放平台</a>。
    平台限制：群聊仅能收到 @ bot 的消息；回复为被动消息（5 分钟窗口，每条 msg_id 最多 5 条）；
    无历史消息 API；发送媒体仅支持公网 https URL。
  </p>
  <div class="cfg-grid-2">
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> AppID</span
      >
      <input
        type="text"
        class="input input-xs input-bordered w-full"
        bind:value={config.qqbot.appId}
        placeholder="q.qq.com 机器人 AppID"
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> AppSecret</span
      >
      <input
        type="password"
        class="input input-xs input-bordered w-full"
        bind:value={config.qqbot.appSecret}
        on:focus={pwFocus}
        on:blur={pwBlur}
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> REST API 根地址</span
      >
      <input
        type="text"
        class="input input-xs input-bordered w-full"
        bind:value={config.qqbot.apiBaseUrl}
        placeholder="https://api.sgroup.qq.com（沙箱：https://sandbox.api.sgroup.qq.com）"
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> 认证服务地址</span
      >
      <input
        type="text"
        class="input input-xs input-bordered w-full"
        bind:value={config.qqbot.authUrl}
        placeholder="https://bots.qq.com/app/getAppAccessToken（一般无需修改）"
      /></label
    >
    <label class="cfg-check col-span-2 mb-1">
      <input
        type="checkbox"
        class="toggle toggle-xs"
        bind:checked={config.qqbot.c2cEnabled}
      />
      <span class="text-xs">接收单聊（C2C）消息</span>
    </label>
  </div>
</div>
