import React, { useState, useRef, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { GoogleLogin } from '@react-oauth/google'
import { ErmisAuthProvider } from '@ermis-network/ermis-chat-sdk'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useTranslation } from 'react-i18next'
import uhmLogo from '../../assets/uhm.svg'
import { parseJwt, validateEmail, validatePhone, normalizePhone } from '../../utils/helpers'
import { STORAGE_KEYS, API_DEFAULTS, OTP_CONFIG } from '../../utils/constants'
import { ThemeToggle } from '../ThemeToggle'
import { LocaleToggle } from '../LocaleToggle'

interface LoginPageProps {
  onLoginSuccess: (userId: string, token: string) => void
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const { t } = useTranslation()
  const [loginMode, setLoginMode] = useState<'email' | 'phone'>('email')
  const [identifier, setIdentifier] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [otpCode, setOtpCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [fieldError, setFieldError] = useState('')
  const [countdown, setCountdown] = useState(0)
  const authProviderRef = useRef<ErmisAuthProvider | null>(null)

  useEffect(() => {
    let timer: NodeJS.Timeout
    if (otpSent && countdown > 0) {
      timer = setTimeout(() => setCountdown(c => c - 1), 1000)
    }
    return () => clearTimeout(timer)
  }, [otpSent, countdown])

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    
    let finalIdentifier = identifier.trim()
    
    if (loginMode === 'email') {
      if (!identifier.trim() || !validateEmail(identifier)) {
        setFieldError(t('errors.invalid_email'))
        return
      }
    } else {
      if (!identifier.trim() || !validatePhone(identifier)) {
        setFieldError(t('errors.invalid_phone'))
        return
      }
      finalIdentifier = normalizePhone(identifier)
    }
    
    setError('')
    setFieldError('')
    setLoading(true)

    try {
      const provider = new ErmisAuthProvider(API_DEFAULTS.API_KEY, API_DEFAULTS.BASE_URL)
      authProviderRef.current = provider

      let res
      if (loginMode === 'email') {
        res = await provider.sendOtpToEmail(finalIdentifier)
      } else {
        res = await provider.sendOtpToPhone(finalIdentifier, OTP_CONFIG.PHONE_METHOD)
      }

      if (res && res.success !== false) {
        setOtpSent(true)
        setCountdown(OTP_CONFIG.COUNTDOWN_SECONDS)
        setOtpCode('') // reset code
      } else {
        setError(res.message || t('errors.otp_failed'))
      }
    } catch (err: any) {
      setError(err?.message || t('errors.system_otp_err'))
    } finally {
      setLoading(false)
    }
  }

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (otpCode.length < OTP_CONFIG.CODE_LENGTH) {
      setError(t('errors.otp_incomplete'))
      return
    }
    setError('')
    setLoading(true)

    try {
      const provider = authProviderRef.current
      if (!provider) throw new Error(t('errors.invalid_session'))

      const res = await provider.verifyOtp(otpCode) as any
      if (res && res.success !== false) {
        const token = res.token || res.data?.token || res.access_token
        if (!token) throw new Error(t('errors.missing_token'))

        const payload = parseJwt(token)
        const finalUserId = res.user_id || res.user?.id || res.data?.user?.id || payload?.user_id || payload?.sub || payload?.id

        if (!finalUserId) throw new Error(t('errors.missing_user'))

        localStorage.setItem(STORAGE_KEYS.USER_ID, finalUserId)
        localStorage.setItem(STORAGE_KEYS.TOKEN, token)
        localStorage.setItem(STORAGE_KEYS.CALL_SESSION_ID, crypto.randomUUID())
        onLoginSuccess(finalUserId, token)
      } else {
        setError(res.message || t('errors.wrong_otp'))
      }
    } catch (err: any) {
      setError(err?.message || t('errors.system_verify_err'))
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleSuccess = async (credentialResponse: any) => {
    setError('')
    setLoading(true)
    try {
      const provider = new ErmisAuthProvider(API_DEFAULTS.API_KEY, API_DEFAULTS.BASE_URL)
      
      const res = await provider.loginWithGoogle(credentialResponse.credential) as any
      if (res && res.success !== false) {
        const token = res.token || res.data?.token || res.access_token
        if (!token) throw new Error(t('errors.missing_token'))

        const payload = parseJwt(token)
        const finalUserId = res.user_id || res.user?.id || res.data?.user?.id || payload?.user_id || payload?.sub || payload?.id
        
        localStorage.setItem(STORAGE_KEYS.USER_ID, finalUserId)
        localStorage.setItem(STORAGE_KEYS.TOKEN, token)
        localStorage.setItem(STORAGE_KEYS.CALL_SESSION_ID, crypto.randomUUID())
        onLoginSuccess(finalUserId, token)
      } else {
        setError(res.message || t('errors.google_failed'))
      }
    } catch (err: any) {
      setError(err?.message || t('errors.system_google_err'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen bg-zinc-50 dark:bg-zinc-950 items-center justify-center p-4 sm:p-8">
      {/* Container chính: card bọc toàn bộ chia đôi trên màn lớn */}
      <div className="w-full max-w-6xl">
        <div className="flex flex-col lg:flex-row overflow-hidden rounded-[2rem] bg-white dark:bg-zinc-900 shadow-2xl border border-zinc-200/50 dark:border-zinc-800/50">
          
          {/* Cột trái (Giới thiệu) */}
          <div className="hidden lg:flex w-1/2 bg-gradient-to-br from-zinc-900 via-zinc-900 to-indigo-950 p-10 xl:p-12 text-white relative overflow-hidden flex-col justify-between">
            {/* Background decorations */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
              <div className="absolute -top-1/4 -left-1/4 w-[40rem] h-[40rem] rounded-full bg-purple-600/20 blur-[120px]" />
              <div className="absolute bottom-1/4 right-0 w-[30rem] h-[30rem] rounded-full bg-blue-600/20 blur-[100px]" />
            </div>
            
            <div className="relative z-10">
              <img src={uhmLogo} alt="Uhm Logo" className="h-14 w-auto object-contain mb-10" />
              <h1 className="text-4xl xl:text-5xl xl:leading-[1.15] font-semibold whitespace-pre-line text-zinc-50 tracking-tight">
                {t('login.hero_title')}
              </h1>
              <p className="mt-6 text-lg text-zinc-300 max-w-md leading-relaxed">
                {t('login.hero_subtitle')}
              </p>
            </div>
            
            <div className="relative z-10">
              <div className="text-sm font-medium text-zinc-500">
                {t('login.hero_footer')}
              </div>
            </div>
          </div>

          {/* Cột phải (Form đăng nhập) */}
          <div className="flex w-full lg:w-1/2 items-center justify-center p-6 sm:p-12 relative overflow-hidden bg-white dark:bg-zinc-900">
            {/* Selectors */}
            <div className="absolute top-4 right-4 sm:top-6 sm:right-6 flex gap-3 z-50">
              <LocaleToggle />
              <ThemeToggle />
            </div>

            {/* Background decoration for mobile */}
            <div className="lg:hidden pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="h-[30rem] w-[30rem] rounded-full bg-purple-500/10 blur-[100px]" />
            </div>

            <div className="z-10 w-full max-w-md">
              {/* Logo cho mobile */}
              <div className="mb-8 flex lg:hidden justify-center items-center">
                <img src={uhmLogo} alt="Uhm Logo" className="h-10 w-auto object-contain" />
              </div>

              <Card className="border-none shadow-none bg-transparent">
                <CardHeader className="space-y-2 text-center lg:text-left px-0">
                  <CardTitle className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
                    {t('login.title')}
                  </CardTitle>
                  <CardDescription className="text-zinc-500 dark:text-zinc-400 text-base">
                    {t('login.description')}
                  </CardDescription>
                </CardHeader>
                <CardContent className="px-0 mt-4">
                  {error && (
                    <div className="mb-6 rounded-xl bg-destructive/10 p-3 text-sm text-destructive border border-destructive/20 text-center font-medium animate-in fade-in zoom-in-95 duration-300">
                      {error}
                    </div>
                  )}

                  {!otpSent ? (
                    <div className="space-y-6">
                      <Tabs value={loginMode} onValueChange={(v) => {
                        setLoginMode(v as 'email' | 'phone')
                        setIdentifier('')
                        setError('')
                        setFieldError('')
                      }} className="w-full">
                        <TabsList className="relative mb-6 grid w-full grid-cols-2 p-1 bg-zinc-100 dark:bg-zinc-800 rounded-xl h-12">
                          <div
                            className={`absolute left-1 top-1 bottom-1 w-[calc(50%-0.25rem)] rounded-lg bg-white dark:bg-zinc-900 shadow-sm transition-transform duration-300 ease-out ${loginMode === 'phone' ? 'translate-x-full' : 'translate-x-0'}`}
                          />
                          <TabsTrigger value="email" className="relative z-10 rounded-lg py-2 data-[state=active]:bg-transparent dark:data-[state=active]:bg-transparent data-[state=active]:shadow-none transition-colors font-medium text-zinc-500 dark:text-zinc-400 data-[state=active]:text-zinc-900 dark:data-[state=active]:text-zinc-50">{t('login.email_tab')}</TabsTrigger>
                          <TabsTrigger value="phone" className="relative z-10 rounded-lg py-2 data-[state=active]:bg-transparent dark:data-[state=active]:bg-transparent data-[state=active]:shadow-none transition-colors font-medium text-zinc-500 dark:text-zinc-400 data-[state=active]:text-zinc-900 dark:data-[state=active]:text-zinc-50">{t('login.phone_tab')}</TabsTrigger>
                        </TabsList>
                        
                        <form onSubmit={handleSendOtp} noValidate className="space-y-6 animate-in fade-in duration-500">
                          <TabsContent value="email" className="mt-0 space-y-2.5 outline-none">
                            <Label htmlFor="email" className="text-zinc-700 dark:text-zinc-300 font-semibold">{t('login.email_label')}</Label>
                            <Input 
                              id="email" 
                              type="text" 
                              value={identifier}
                              onChange={(e) => { setIdentifier(e.target.value); setFieldError('') }}
                              onBlur={() => {
                                if (identifier.trim() && !validateEmail(identifier)) setFieldError(t('errors.invalid_email'))
                              }}
                              placeholder={t('login.email_placeholder')} 
                              disabled={loading}
                              className={`bg-zinc-50 dark:bg-zinc-950 border-zinc-200 dark:border-zinc-800 h-12 rounded-xl focus-visible:ring-purple-500 ${fieldError && loginMode === 'email' ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                            />
                            {fieldError && loginMode === 'email' && (
                              <p className="text-xs text-destructive mt-1 animate-in fade-in duration-200">{fieldError}</p>
                            )}
                          </TabsContent>

                          <TabsContent value="phone" className="mt-0 space-y-2.5 outline-none">
                            <Label htmlFor="phone" className="text-zinc-700 dark:text-zinc-300 font-semibold">{t('login.phone_label')}</Label>
                            <div className="flex rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 overflow-hidden focus-within:ring-2 focus-within:ring-purple-500 focus-within:border-transparent transition-all h-12">
                              <div className="flex items-center justify-center bg-zinc-100 dark:bg-zinc-900 px-4 border-r border-zinc-200 dark:border-zinc-800">
                                <span className="mr-2 text-base select-none">🇻🇳</span>
                                <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 select-none">+84</span>
                              </div>
                              <input 
                                id="phone"
                                type="tel"
                                value={identifier}
                                onChange={(e) => { setIdentifier(e.target.value); setFieldError('') }}
                                onBlur={() => {
                                  if (identifier.trim() && !validatePhone(identifier)) setFieldError(t('errors.invalid_phone'))
                                }}
                                className="flex-1 bg-transparent px-4 py-2 text-sm focus:outline-none placeholder:text-zinc-400 dark:placeholder:text-zinc-600 text-zinc-900 dark:text-zinc-100"
                                placeholder={t('login.phone_placeholder')}
                                disabled={loading}
                              />
                            </div>
                            {fieldError && loginMode === 'phone' && (
                              <p className="text-xs text-destructive mt-1 animate-in fade-in duration-200">{fieldError}</p>
                            )}
                          </TabsContent>

                          <Button type="submit" disabled={loading} className="w-full h-12 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-semibold text-base transition-colors shadow-lg shadow-purple-500/20">
                            {loading ? t('login.sending') : t('login.send_otp')}
                          </Button>
                        </form>
                      </Tabs>
                    </div>
                  ) : (
                    <form onSubmit={handleVerifyOtp} className="space-y-8 animate-in slide-in-from-right-8 fade-in duration-500">
                      <div className="space-y-6">
                        <div className="text-center lg:text-left">
                          <Label className="text-base text-zinc-700 dark:text-zinc-300 font-semibold">{t('login.otp_label')}</Label>
                          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-2">
                            {t('login.otp_desc').replace('{{identifier}}', identifier)}
                          </p>
                        </div>
                        
                        <div className="flex justify-center lg:justify-start gap-2 sm:gap-3">
                          {Array.from({ length: 6 }).map((_, idx) => (
                            <Input
                              key={idx}
                              id={`otp-input-${idx}`}
                              type="text"
                              inputMode="numeric"
                              maxLength={1}
                              value={otpCode[idx] || ''}
                              disabled={loading}
                              onChange={(e) => {
                                const val = e.target.value.replace(/\D/g, '')
                                if (!val) return
                                
                                const newOtp = otpCode.split('')
                                newOtp[idx] = val
                                const finalOtp = newOtp.join('')
                                setOtpCode(finalOtp.slice(0, 6))

                                if (val && idx < 5) {
                                  const next = document.getElementById(`otp-input-${idx + 1}`)
                                  next?.focus()
                                }
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Backspace') {
                                  e.preventDefault()
                                  const newOtp = otpCode.split('')
                                  newOtp[idx] = ''
                                  setOtpCode(newOtp.join(''))
                                  if (idx > 0) {
                                    const prev = document.getElementById(`otp-input-${idx - 1}`)
                                    prev?.focus()
                                  }
                                }
                              }}
                              onPaste={(e) => {
                                e.preventDefault()
                                const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
                                if (pasted) {
                                  setOtpCode(pasted)
                                  const focusIdx = Math.min(pasted.length, 5)
                                  document.getElementById(`otp-input-${focusIdx === 6 ? 5 : focusIdx}`)?.focus()
                                }
                              }}
                              className="h-12 w-10 sm:h-14 sm:w-12 rounded-xl text-center text-xl font-bold bg-zinc-50 dark:bg-zinc-950 border-zinc-200 dark:border-zinc-800 focus-visible:ring-purple-500 focus-visible:border-transparent transition-all"
                            />
                          ))}
                        </div>
                      </div>

                      <div className="flex flex-col gap-4">
                        <Button type="submit" disabled={loading || otpCode.length < 6} className="w-full h-12 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-semibold text-base transition-colors shadow-lg shadow-purple-500/20">
                          {loading ? t('login.verifying') : t('login.verify')}
                        </Button>
                        <div className="flex gap-3">
                          <Button type="button" variant="outline" disabled={loading} onClick={() => setOtpSent(false)} className="flex-1 h-12 rounded-xl border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 font-medium">
                            {t('login.back')}
                          </Button>
                          <Button type="button" variant="secondary" disabled={countdown > 0 || loading} onClick={handleSendOtp} className="flex-1 h-12 rounded-xl bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 font-medium transition-colors">
                            {countdown > 0 ? t('login.resend_wait').replace('{{seconds}}', countdown.toString()) : t('login.resend')}
                          </Button>
                        </div>
                      </div>
                    </form>
                  )}

                  {!otpSent && (
                    <>
                      <div className="relative my-8">
                        <div className="absolute inset-0 flex items-center">
                          <span className="w-full border-t border-zinc-200 dark:border-zinc-800" />
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                          <span className="bg-white dark:bg-zinc-900 px-3 text-zinc-500 dark:text-zinc-400 font-semibold tracking-wider">
                            {t('login.or_continue')}
                          </span>
                        </div>
                      </div>

                      <div className="flex justify-center">
                        <GoogleLogin
                          onSuccess={handleGoogleSuccess}
                          onError={() => setError(t('errors.google_connect'))}
                          theme="outline"
                          shape="rectangular"
                          width="100%"
                          locale="vi"
                        />
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

