// Shared client state.
export const store = {
  state: null,      // latest /api/state response
  serverOffset: 0   // server clock − local clock (ms)
};

export const serverNow = () => Date.now() + store.serverOffset;

export const formatClock = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
