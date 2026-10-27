function sanitize (value) {
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function createBuildId (version, explicit = process.env.ELECTERM_BUILD_ID) {
  const id = sanitize(explicit || version)
  if (!id) throw new Error('build ID must contain a letter or number')
  return id
}

module.exports = { createBuildId }
