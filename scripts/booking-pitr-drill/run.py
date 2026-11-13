#!/usr/bin/env python3
"""Deploy, verify, and delete a uniquely named isolated remote PITR fixture.

Uses only the project's installed Wrangler and existing authentication. Evidence,
bookmarks, endpoints, random fixture secrets and account selection stay in a
private directory outside Git. This is not a production restore tool.
"""
import base64
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[2]
WRANGLER = ROOT / 'apps/booking/node_modules/.bin/wrangler'


def main():
    os.umask(0o077)
    account = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
    if not re.fullmatch(r'[a-f0-9]{32}', account):
        raise SystemExit('Set CLOUDFLARE_ACCOUNT_ID to the authorized fixture account.')
    state = Path(tempfile.mkdtemp(prefix='email-booking-pitr-drill-'))
    name = 'email-booking-pitr-drill-' + secrets.token_hex(8)
    assert re.fullmatch(r'email-booking-pitr-drill-[a-f0-9]{16}', name)
    secret = secrets.token_urlsafe(48)
    secret_file = state / 'secrets.json'
    secret_file.write_text(json.dumps({'DRILL_AUTH': secret, 'TOKEN_ENCRYPTION_KEY': base64.b64encode(secrets.token_bytes(32)).decode()}))
    classes = ['FixtureHost', 'FixtureEffects', 'AuthStore']
    config = {'name': name, 'account_id': account,
              'main': str(ROOT / 'scripts/booking-pitr-drill/worker.js'),
              'compatibility_date': '2026-11-11', 'workers_dev': True,
              'preview_urls': False, 'routes': [], 'upload_source_maps': False,
              'observability': {'enabled': False},
              'durable_objects': {'bindings': [{'name': binding, 'class_name': cls}
                                               for binding, cls in [('HOST','FixtureHost'), ('EFFECTS','FixtureEffects'), ('AUTH','AuthStore')]]},
              'exports': {cls: {'type':'durable-object','storage':'sqlite'} for cls in classes}}
    config_file = state / 'wrangler.jsonc'
    config_file.write_text(json.dumps(config, indent=2))
    (state / 'empty.env').write_text('')
    evidence = {'fixtureName': name, 'steps': []}
    (state / 'state.json').write_text(json.dumps({'account':account,'fixtureName':name,'config':str(config_file)}, indent=2))
    print('Private fixture state: ' + str(state), flush=True)

    def command(label, *args, input_text=None):
        completed = subprocess.run([str(WRANGLER), *args, '--config', str(config_file), '--env-file', str(state / 'empty.env')],
                                   cwd=state, text=True, input=input_text, capture_output=True)
        (state / (label + '.log')).write_text(completed.stdout + completed.stderr)
        if completed.returncode:
            raise RuntimeError(label + ' failed; inspect protected fixture evidence')
        return completed.stdout

    deployed = False
    deleted_namespaces = False
    try:
        command('dry-run', 'deploy', '--dry-run', '--outdir', str(state / 'bundle'))
        # The Worker has no routes/existing namespaces/real provider credentials.
        deployed = True  # cleanup also runs if upload partially succeeds
        output = command('deploy', 'deploy', '--secrets-file', str(secret_file), '--message', 'Disposable isolated SQLite PITR fixture')
        endpoints = re.findall(r'https://' + re.escape(name) + r'\.[a-z0-9-]+\.workers\.dev', output)
        if not endpoints:
            raise RuntimeError('fixture endpoint missing; protected deployment log retained')
        endpoint = endpoints[0]
        (state / 'endpoint.txt').write_text(endpoint)

        def call(action, **fields):
            request = urllib.request.Request(endpoint + '/drill', data=json.dumps({'action':action, **fields}).encode(),
                                             headers={'Authorization':'Bearer '+secret, 'Content-Type':'application/json', 'User-Agent':'Email-PITR-Fixture/1.0'}, method='POST')
            try:
                with urllib.request.urlopen(request, timeout=40) as response:
                    result = json.load(response)
            except urllib.error.HTTPError as error:
                (state / ('http-error-' + action + '.json')).write_text(json.dumps({'status':error.code,'headers':dict(error.headers),'body':error.read(8192).decode(errors='replace')},indent=2))
                raise RuntimeError('fixture request failed with HTTP ' + str(error.code) + '; protected error evidence retained') from None
            evidence['steps'].append({'action':action, 'result':result})
            (state / 'evidence.json').write_text(json.dumps(evidence, indent=2))
            return result

        def state_assert(value, *, marker, frozen, mail, quarantined=None):
            assert value['marker'] == marker and value['kvMarker'] == marker
            assert value['operations']['outbound']['frozen'] is frozen
            assert value['guestCapabilityWorks'] is True
            effects=value['effects']
            assert effects == {'calendar':2,'mail':mail,'calendarAttempts':2,'mailAttempts':mail,'duplicates':0}, effects
            if quarantined is not None:
                review=value['operations']['deliveries']['review']
                assert review['count'] == quarantined, review

        def freeze(value):
            result=call('freeze',epoch=value['operations']['outbound']['epoch'])
            assert result.get('ok') is True and result['maintenance']['frozen'] is True
            assert result['maintenance']['inFlight'] == {'calendar':0,'deliveries':0}
            return result

        # A newly deployed workers.dev route can take time to reach the edge.
        # Bounded readiness reads carry no authorization and mutate no fixture.
        ready=False
        for attempt in range(7):
            try:
                response=urllib.request.urlopen(urllib.request.Request(endpoint+'/drill',headers={'User-Agent':'Email-PITR-Fixture/1.0'}),timeout=10)
                value={'status':response.status,'headers':dict(response.headers),'body':response.read(8192).decode(errors='replace')}
                response.close()
            except urllib.error.HTTPError as error:
                value={'status':error.code,'headers':dict(error.headers),'body':error.read(8192).decode(errors='replace')}
            (state/f'unauthenticated-probe-{attempt}.json').write_text(json.dumps(value,indent=2))
            if value['status']==404 and value['body']=='Not found':
                ready=True;break
            if attempt<6:time.sleep(5)
        if not ready:
            raise RuntimeError('fixture public endpoint did not reach the expected auth gate within the bounded readiness window; protected evidence retained')
        initial=call('initialize');state_assert(initial,marker='baseline',frozen=False,mail=0)
        bookmark=call('bookmark')['bookmark'];assert re.fullmatch(r'[a-f0-9-]+',bookmark) and re.search('[1-9a-f]',bookmark)
        advanced=call('advance');state_assert(advanced,marker='advanced',frozen=False,mail=1)
        freeze(advanced)
        prepared=call('prepare',label='baseline');assert prepared['prepared'] and prepared['undo'] != bookmark
        call('restart')
        restored=call('status');state_assert(restored,marker='baseline',frozen=True,mail=1,quarantined=2)
        assert restored['operations']['outbound']['reason'] == 'restore_detected'
        probe=call('probe');assert probe['repair']['code']=='maintenance_frozen' and probe['availability']['code']=='maintenance_frozen'
        reconciled=call('reconcile');assert reconciled['operations']['deliveries']['review']['count']==0
        resumed=call('resume',epoch=reconciled['operations']['outbound']['epoch']);assert resumed.get('ok') is True
        drained=call('drain');state_assert(drained,marker='baseline',frozen=False,mail=2,quarantined=0)
        assert drained['operations']['deliveries']['queued']==0

        # Exercise the actual special undo bookmark, held outside restored storage.
        freeze(drained);call('prepare',label='undo-baseline');call('restart')
        undone=call('status');state_assert(undone,marker='advanced',frozen=True,mail=2,quarantined=1)
        reconciled=call('reconcile');assert reconciled['operations']['deliveries']['review']['count']==0
        assert call('resume',epoch=reconciled['operations']['outbound']['epoch']).get('ok') is True
        drained=call('drain');state_assert(drained,marker='advanced',frozen=False,mail=2,quarantined=0)

        # Inject a lost local commit after AUTH acknowledges resume. Startup must
        # conservatively freeze again instead of assuming the gate opened safely.
        frozen=freeze(drained)
        interrupted=call('interrupted-resume',epoch=frozen['maintenance']['epoch']);assert interrupted['status']==503
        call('restart');checked=call('status')
        state_assert(checked,marker='advanced',frozen=True,mail=2,quarantined=0)
        assert checked['operations']['outbound']['reason']=='restore_detected'
        evidence['result']='passed'
        print('Remote PITR, undo and interrupted-resume checks passed.', flush=True)
    finally:
        if deployed:
            # Retire ONLY the three newly created namespaces, using declarative
            # tombstones, before deleting ONLY the uniquely named fixture Worker.
            cleanup = state / 'cleanup.js'
            cleanup.write_text("export default {fetch(){return new Response('Gone',{status:410});}};\n")
            config['main']=str(cleanup)
            config['durable_objects']={'bindings':[]}
            config['exports']={cls:{'type':'durable-object','state':'deleted'} for cls in classes}
            config_file.write_text(json.dumps(config,indent=2))
            try:
                command('delete-namespaces','deploy','--message','Delete only disposable fixture namespaces')
                deleted_namespaces=True
                command('delete-worker','delete',name,input_text='y\n')
                evidence['cleanup']={'namespacesDeleted':True,'workerDeleted':True}
                print('Disposable namespaces and Worker deleted.',flush=True)
            except Exception:
                evidence['cleanup']={'namespacesDeleted':deleted_namespaces,'workerDeleted':False}
                print('Fixture cleanup needs attention; protected evidence retained.',flush=True)
                raise
            finally:
                (state/'evidence.json').write_text(json.dumps(evidence,indent=2))


if __name__ == '__main__':
    main()
