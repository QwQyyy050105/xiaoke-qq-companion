import {fetch as proxyFetch, ProxyAgent} from 'undici';
import {HttpsProxyAgent} from 'https-proxy-agent';

// One configured route for both QQ HTTPS requests and its WSS gateway.
// Never silently fall back to a failing direct connection.
export function createQQNetworkTransport(value) {
  if(!value)return {fetcher:globalThis.fetch,webSocketAgent:undefined,close:async()=>{}};
  const proxy=new URL(value);
  if(!['http:','https:'].includes(proxy.protocol)||proxy.username||proxy.password||proxy.search||proxy.hash||!['','/'].includes(proxy.pathname))throw Error('qq_invalid_proxy');
  const dispatcher=new ProxyAgent(proxy.href);
  const webSocketAgent=new HttpsProxyAgent(proxy);
  return {
    fetcher:(input,init={})=>proxyFetch(input,{...init,dispatcher}),
    webSocketAgent,
    close:async()=>{webSocketAgent.destroy();await dispatcher.close();}
  };
}
