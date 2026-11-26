// Microsoft -> Xbox Live -> Minecraft login (device code flow). Needs an Azure app client ID approved for Minecraft APIs.
const MS = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'
const XERR = {
  2148916233: 'This Microsoft account has no Xbox profile. Sign in once at minecraft.net, then try again.',
  2148916235: 'Xbox Live is not available in your country.',
  2148916236: 'This account needs adult verification on xbox.com.',
  2148916237: 'This account needs adult verification on xbox.com.',
  2148916238: 'Child account: an adult must add it to a Microsoft family first.',
}

async function call(url, body, form) {
  const r = await fetch(url, {
    method: 'POST',
    headers: form ? {} : { 'content-type': 'application/json', accept: 'application/json' },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const e = new Error(XERR[data.XErr] || data.error_description?.split('\r\n')[0] || data.errorMessage || `Login failed (HTTP ${r.status})`)
    e.code = data.error; throw e
  }
  return data
}

const SCOPE = 'XboxLive.signin offline_access'
module.exports = {
  deviceCode: clientId => call(`${MS}/devicecode`, { client_id: clientId, scope: SCOPE }, true),

  async waitForToken(clientId, { device_code, interval = 5, expires_in = 900 }) {
    const end = Date.now() + expires_in * 1000
    while (Date.now() < end) {
      await new Promise(r => setTimeout(r, interval * 1000))
      try { return await call(`${MS}/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code }, true) }
      catch (e) { if (e.code === 'slow_down') interval += 5; else if (e.code !== 'authorization_pending') throw e }
    }
    throw new Error('Login timed out')
  },

  refresh: (clientId, refresh_token) => call(`${MS}/token`, { grant_type: 'refresh_token', client_id: clientId, refresh_token, scope: SCOPE }, true),

  // Microsoft access token -> Minecraft session { token, expires, uuid, name, xuid }
  async minecraft(msToken) {
    const xbl = await call('https://user.auth.xboxlive.com/user/authenticate', {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msToken}` }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' })
    const xsts = await call('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' })
    const uhs = xsts.DisplayClaims.xui[0].uhs
    const mc = await call('https://api.minecraftservices.com/authentication/login_with_xbox', { identityToken: `XBL3.0 x=${uhs};${xsts.Token}` })
    const r = await fetch('https://api.minecraftservices.com/minecraft/profile', { headers: { authorization: `Bearer ${mc.access_token}` } })
    if (r.status === 404) throw new Error("This account doesn't own Minecraft: Java Edition")
    if (!r.ok) throw new Error(`Minecraft profile failed (HTTP ${r.status})`)
    const profile = await r.json()
    return { token: mc.access_token, expires: Date.now() + mc.expires_in * 1000, uuid: profile.id, name: profile.name, skin: profile.skins?.[0]?.url, xuid: xsts.DisplayClaims.xui[0].xid }
  },
}
