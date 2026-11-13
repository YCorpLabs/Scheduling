(()=>{
  const script=document.currentScript,service=new URL(script.src).origin;
  const frames=new Map();
  function frame(url,motion){const f=document.createElement('iframe');const u=new URL(url,service);if(u.origin!==service)throw Error('Booking origin must match script origin');u.searchParams.set('embed','1');if(['smooth','none'].includes(motion))u.searchParams.set('motion',motion);f.src=u.href;f.title='Book a meeting';f.style.cssText='width:100%;height:740px;border:0;display:block;background:transparent;border-radius:16px';f.setAttribute('loading','lazy');frames.set(f,u.origin);return f;}
  window.addEventListener('message',e=>{for(const[f,origin]of frames){if(e.source===f.contentWindow&&e.origin===origin&&e.data?.type==='email-booking:resize'&&Number.isFinite(e.data.height)){f.style.height=Math.min(1600,Math.max(400,e.data.height))+'px';}}});
  document.querySelectorAll('[data-email-booking]').forEach(el=>{
    if(el.dataset.bookingReady)return;el.dataset.bookingReady='1';
    if(!el.matches('button,a')){el.append(frame(el.dataset.emailBooking,el.dataset.emailMotion));return;}
    el.addEventListener('click',e=>{e.preventDefault();
      const dialog=document.createElement('dialog');dialog.setAttribute('aria-label','Book a meeting');dialog.style.cssText='padding:0;border:1px solid #8884;border-radius:12px;width:min(1080px,calc(100vw - 24px));max-width:none;max-height:calc(100dvh - 24px);background:#f8f9fa;overflow:auto;box-shadow:0 25px 100px #0005';
      const close=document.createElement('button');close.type='button';close.textContent='Close ×';close.style.cssText='display:block;margin:10px 18px 0 auto;border:0;border-radius:6px;padding:8px 12px;background:#eee;color:#333;cursor:pointer;font:13px system-ui';close.setAttribute('aria-label','Close booking');
      const f=frame(el.dataset.emailBooking,el.dataset.emailMotion);f.loading='eager';dialog.append(close,f);document.body.append(dialog);
      dialog.addEventListener('close',()=>{frames.delete(f);dialog.remove();el.focus();},{once:true});
      close.onclick=()=>dialog.close();dialog.addEventListener('click',evt=>{if(evt.target===dialog){const r=dialog.getBoundingClientRect();if(evt.clientX<r.left||evt.clientX>r.right||evt.clientY<r.top||evt.clientY>r.bottom)dialog.close();}});
      dialog.showModal();close.focus();
    });
  });
})();
