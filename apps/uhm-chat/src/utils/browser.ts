// Safari detection — WebRTC call features are not supported on Safari
export const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
