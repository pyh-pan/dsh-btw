export function createApi({ fetch = globalThis.fetch.bind(globalThis), EventSource = globalThis.EventSource, connectionMessage = 'Side conversation connection interrupted; reconnecting…' } = {}) {
  async function call(method, args = {}) {
    const response = await fetch('/plugins/dsh-btw/api', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args })
    });
    let result;
    try { result = await response.json(); }
    catch (cause) {
      const error = new Error(`BTW request failed (${response.status})`, { cause });
      error.code = response.status === 410 ? 'BTW_EXPIRED' : 'btw/transport';
      error.status = response.status;
      throw error;
    }
    if (!response.ok || !result.ok) {
      const error = new Error(result.error?.message ?? `BTW request failed (${response.status})`);
      error.code = result.error?.code ?? (response.status === 410 ? 'BTW_EXPIRED' : 'btw/transport');
      error.status = response.status;
      throw error;
    }
    return result.value;
  }
  return {
    create: args => call('create', args), send: args => call('send', args),
    state: args => call('state', args), stop: args => call('stop', args),
    close: args => call('close', args), list: args => call('list', args),
    watch(args, onState, onError) {
      const query = new URLSearchParams(args);
      const stream = new EventSource(`/plugins/dsh-btw/events?${query}`);
      let active = true;
      let checking = false;
      stream.onmessage = event => {
        if (!active) return;
        try {
          const state = JSON.parse(event.data);
          onState(state);
          if (state.closed) { active = false; stream.close(); }
        } catch (error) { onError(error); }
      };
      stream.onerror = async () => {
        if (!active || checking) return;
        checking = true;
        onError(new Error(connectionMessage));
        try {
          // EventSource hides HTTP 410. Probe the authenticated state endpoint
          // once per failure burst to distinguish expiry from a network outage.
          const state = await call('state', args);
          if (!active) return;
          if (state.closed) { active = false; stream.close(); }
          onState(state);
        } catch (error) {
          if (!active) return;
          if (error.code === 'BTW_EXPIRED' || error.code === 'BTW_CLOSED' || error.status === 410) {
            active = false;
            stream.close();
            onState({ ...args, closed: true, status: 'closed', expired: true });
          }
          // Real transport failures retain native EventSource reconnection.
        } finally { checking = false; }
      };
      return () => { active = false; stream.close(); };
    }
  };
}
