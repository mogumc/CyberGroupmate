<script>
  export let config;
  export let wechatEnabled = false;
  export let pwFocus;
  export let pwBlur;
</script>

<h3 class="card-title text-sm">
  <i class="fa-solid fa-comment-dots opacity-50 mr-1"></i> 微信设置
</h3>
<label class="cfg-check mb-2">
  <input
    type="checkbox"
    class="toggle toggle-sm"
    bind:checked={wechatEnabled}
  />
  <span class="text-sm font-medium">启用微信 Adapter</span>
</label>
{#if !wechatEnabled}
  <p class="text-xs opacity-40 italic mb-3">未启用，设置不会保存到配置文件。</p>
{/if}
<div class:opacity-40={!wechatEnabled} class:pointer-events-none={!wechatEnabled}>
  <p class="text-xs opacity-50 mb-3">
    对接 Claw / OpenClaw-weixin 协议（Tencent iLink bot）。独立 adapter，与 QQ / OneBot、QQ 官方 Bot
    完全独立、可同时启用。不填 token 时启动后进入扫码登录：二维码打印在终端并显示在
    Dashboard「平台连接」面板，登录凭据持久化，重启免扫码（会话超时后需重新扫码）。
    平台限制：无历史消息 API；回复优先为被动回复；发送媒体走 iLink CDN（图片/视频/文件），语音发送暂不支持。
  </p>
  <div class="cfg-grid-2">
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> Bot Token（可选）</span
      >
      <input
        type="password"
        class="input input-xs input-bordered w-full"
        bind:value={config.wechat.token}
        on:focus={pwFocus}
        on:blur={pwBlur}
        placeholder="留空则启动时扫码登录；也可从 openclaw-weixin 插件凭据导入"
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> 会话名</span
      >
      <input
        type="text"
        class="input input-xs input-bordered w-full"
        bind:value={config.wechat.sessionName}
        placeholder="default（多账号时用不同名字）"
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label"
        ><i class="fa-solid fa-rotate-right restart-icon"></i> iLink 网关地址</span
      >
      <input
        type="text"
        class="input input-xs input-bordered w-full"
        bind:value={config.wechat.apiBaseUrl}
        placeholder="https://ilinkai.weixin.qq.com（一般无需修改）"
      /></label
    >
    <label class="cfg-field"
      ><span class="cfg-label">bot_agent 自我声明</span>
      <input
        type="text"
        class="input input-xs input-bordered w-full"
        bind:value={config.wechat.botAgent}
        placeholder="CyberGroupmate/0.1.0（仅用于后台观测）"
      /></label
    >
  </div>
</div>
