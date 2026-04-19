export const getUiCookie = async (baseUrl: string) => {
  const response = await fetch(`${baseUrl}/api/ui/session`)
  const cookie = response.headers.get('set-cookie')
  if (!cookie) {
    throw new Error('Expected UI session cookie')
  }
  return cookie
}
