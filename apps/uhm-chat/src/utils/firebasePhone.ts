import { getApp, getApps, initializeApp } from '@firebase/app'
import { getAuth, RecaptchaVerifier, signInWithPhoneNumber, signOut, type ConfirmationResult } from '@firebase/auth'

// Separate Firebase session: never replace Ermis identity/session with a Firebase UID.
function phoneAuth() {
  const name = 'uhm-phone'
  const config = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  }
  if (Object.values(config).some(value => !value)) {
    throw new Error('Dịch vụ xác thực điện thoại chưa được cấu hình. Vui lòng chọn phương thức đăng nhập khác.')
  }
  const app = getApps().some(app => app.name === name) ? getApp(name) : initializeApp(config, name)
  return getAuth(app)
}

export class FirebasePhoneChallenge {
  private widget?: HTMLElement
  private verifier?: RecaptchaVerifier
  private confirmation?: ConfirmationResult
  private generation = 0
  async send(phone: string, container: HTMLElement) {
    this.clear()
    const generation = this.generation
    const auth = phoneAuth()
    // reCAPTCHA remembers rendered element identity even after verifier.clear().
    // Give each request a new owned child, while React retains the outer container.
    const widget = container.ownerDocument.createElement('div')
    container.appendChild(widget)
    this.widget = widget
    try {
      this.verifier = new RecaptchaVerifier(auth, widget, { size: 'invisible' })
      const confirmation = await signInWithPhoneNumber(auth, phone, this.verifier)
      if (generation !== this.generation) throw new Error('Yêu cầu OTP đã bị hủy.')
      this.confirmation = confirmation
    } catch (error) {
      if (generation === this.generation) this.clear()
      throw error
    }
  }
  async verify(code: string): Promise<string> {
    if (!this.confirmation) throw new Error('Vui lòng yêu cầu mã OTP mới.')
    const generation = this.generation
    const credential = await this.confirmation.confirm(code)
    const token = await credential.user.getIdToken()
    if (generation !== this.generation) throw new Error('Yêu cầu OTP đã bị hủy.')
    return token
  }
  clear() {
    this.generation++
    this.confirmation = undefined
    try {
      this.verifier?.clear()
    } finally {
      this.verifier = undefined
      this.widget?.remove()
      this.widget = undefined
    }
  }
  async finish() {
    this.clear()
    await signOut(phoneAuth())
  }
}

export function firebasePhoneErrorKey(error: unknown): string | undefined {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  switch (code) {
    case 'auth/invalid-verification-code': return 'wrong_otp'
    case 'auth/code-expired':
    case 'auth/session-expired': return 'phone_otp_expired'
    case 'auth/too-many-requests': return 'phone_rate_limited'
    case 'auth/network-request-failed':
    case 'auth/quota-exceeded':
    case 'auth/invalid-app-credential':
    case 'auth/app-not-authorized':
    case 'auth/unauthorized-domain':
    case 'auth/operation-not-allowed':
    case 'auth/billing-not-enabled':
    case 'auth/invalid-api-key':
    case 'auth/api-key-not-valid.-please-pass-a-valid-api-key.': return 'phone_service_unavailable'
    default: return undefined
  }
}
