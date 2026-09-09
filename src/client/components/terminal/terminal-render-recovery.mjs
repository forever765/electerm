export function refreshTerminalAfterWindowFocus (term) {
  if (!term) {
    return
  }
  term.focus()
  term.refresh(0, term.rows - 1)
}

export function createSingleFlight (operation) {
  let active
  return (...args) => {
    if (active) {
      return active
    }
    let result
    try {
      result = operation(...args)
    } catch (error) {
      result = Promise.reject(error)
    }
    active = Promise.resolve(result).finally(() => {
      active = null
    })
    return active
  }
}
