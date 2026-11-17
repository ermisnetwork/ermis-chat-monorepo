/** Per-client HTTP concurrency. Deadlines/cancellation remove waiters; no auth refresh holds a permit. */
export class SessionNetworkBudget {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly limit = 2, private readonly maxWaiting = 256) {}
  acquire(deadline?: number, signal?: {aborted: boolean; addEventListener?: Function; removeEventListener?: Function}): Promise<() => void> {
    return new Promise((resolve,reject)=>{
      let done=false,timer:ReturnType<typeof setTimeout>|undefined;
      const cleanup=()=>{if(timer)clearTimeout(timer);signal?.removeEventListener?.('abort',abort);};
      const fail=(code:string)=>{if(done)return;done=true;cleanup();this.waiting=this.waiting.filter(w=>w!==admit);reject(Object.assign(Error(code),{code}));};
      const abort=()=>fail('request_cancelled');
      const admit=()=>{
        if(done)return;
        if(signal?.aborted){abort();return;}
        if(deadline!==undefined && Date.now()>=deadline){fail('key_package_ownership_deadline');return;}
        done=true;cleanup();this.active++;
        let released=false;
        resolve(()=>{if(released)return;released=true;this.active--;this.drain();});
      };
      if(signal?.aborted){abort();return;}
      if(deadline!==undefined){if(Date.now()>=deadline){fail('key_package_ownership_deadline');return;}timer=setTimeout(()=>fail('key_package_ownership_deadline'),deadline-Date.now());}
      signal?.addEventListener?.('abort',abort,{once:true});
      if(this.active<this.limit)admit();
      else if(this.waiting.length>=this.maxWaiting)fail('network_queue_full');
      else this.waiting.push(admit);
    });
  }
  private drain(){while(this.active<this.limit && this.waiting.length)this.waiting.shift()!();}
}
