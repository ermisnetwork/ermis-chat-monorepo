export function parseJwt(token: string) {
  try {
    const base64Url = token.split('.')[1]
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    )
    return JSON.parse(jsonPayload)
  } catch (e) {
    return null
  }
}

export const validateEmail = (email: string) => {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return re.test(email)
}

export const normalizePhone = (phone: string): string => {
  const digits = phone.replace(/\D/g, '')
  const national = digits.length === 10 && digits.startsWith('0')
    ? digits.slice(1)
    : digits.length === 11 && digits.startsWith('84') ? digits.slice(2) : digits
  return /^[35789]\d{8}$/.test(national) ? `+84${national}` : ''
}

export const validatePhone = (phone: string) => normalizePhone(phone) !== ''
