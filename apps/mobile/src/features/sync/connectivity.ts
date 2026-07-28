import NetInfo from '@react-native-community/netinfo';
import { type ConnectivityProbe } from './engine';

/**
 * Connectivity.
 *
 * `isInternetReachable` matters more than `isConnected` in this market: a phone
 * frequently holds a mobile data connection that carries no usable traffic, and
 * treating that as online would burn the retry budget on requests that cannot
 * succeed. When reachability is still unknown (null), we assume online and let
 * the request itself decide — a failed attempt costs one retry, whereas
 * incorrectly assuming offline stalls the queue indefinitely.
 */
class NetInfoConnectivity implements ConnectivityProbe {
  async isOnline(): Promise<boolean> {
    const state = await NetInfo.fetch();
    if (state.isConnected === false) return false;
    if (state.isInternetReachable === false) return false;
    return true;
  }
}

let probe: ConnectivityProbe | null = null;

export function getConnectivity(): ConnectivityProbe {
  if (!probe) probe = new NetInfoConnectivity();
  return probe;
}

/** Test seam. */
export function setConnectivityForTests(next: ConnectivityProbe | null): void {
  probe = next;
}

/**
 * Subscribes to connectivity changes so the outbox drains the moment a signal
 * returns, rather than waiting for the merchant to open a screen.
 */
export function onConnectivityRestored(callback: () => void): () => void {
  let wasOnline = true;
  return NetInfo.addEventListener((state) => {
    const isOnline = state.isConnected !== false && state.isInternetReachable !== false;
    if (isOnline && !wasOnline) callback();
    wasOnline = isOnline;
  });
}
