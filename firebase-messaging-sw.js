/* Web-push service worker (FCM). App ise firebase-messaging-sw.js?c=<base64 firebase config> ke saath register karta hai */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js','https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

try{
  const q=new URL(self.location.href).searchParams.get('c');
  firebase.initializeApp(JSON.parse(atob(q)));
  const messaging=firebase.messaging();
  // Backend data-only message bhejta hai, notification yaha dikhate hain
  messaging.onBackgroundMessage(p=>{
    const d=p.data||{};
    return self.registration.showNotification(d.title||'New message',{
      body:d.body||'',
      tag:d.tag||d.chatId||d.callId||undefined,
      renotify:true,
      icon:d.icon||undefined,
      requireInteraction:d.kind==='call',
      vibrate:d.kind==='call'?[300,150,300,150,300]:[120],
      data:d
    });
  });
}catch(e){ /* config missing */ }

self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const d=e.notification.data||{};
  const url=d.chatId?('./?chat='+encodeURIComponent(d.chatId)):'./';
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const c of list){
      if('focus' in c){ c.postMessage({type:'open',chatId:d.chatId||null,callId:d.callId||null}); return c.focus(); }
    }
    return clients.openWindow(url);
  }));
});
