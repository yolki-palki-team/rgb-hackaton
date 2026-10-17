import { contextBridge, ipcRenderer } from 'electron';

type Method='GET'|'POST';
type OfferCallback=(orderId:string)=>void;

const palkaWallet={
  connect:():Promise<unknown>=>ipcRenderer.invoke('wallet:connect'),
  request:(method:Method,path:string,body?:unknown):Promise<unknown>=>ipcRenderer.invoke('wallet:request',method,path,body),
  approveTrade:(tradeId:string,approvalToken:string):Promise<unknown>=>ipcRenderer.invoke('wallet:approve',tradeId,approvalToken),
  getPendingOffer:():Promise<string|null>=>ipcRenderer.invoke('offer:pending'),
  onOfferSelected:(callback:OfferCallback):(()=>void)=>{
    const listener=(_event:Electron.IpcRendererEvent,orderId:unknown)=>{if(typeof orderId==='string') callback(orderId);};
    ipcRenderer.on('offer:selected',listener);
    return ()=>ipcRenderer.removeListener('offer:selected',listener);
  },
  openPublicMarket:():Promise<void>=>ipcRenderer.invoke('market:open'),
};

contextBridge.exposeInMainWorld('palkaWallet',palkaWallet);
