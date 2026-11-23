"""Phase 5b stage 2 draw. Usage: python3 draw_stage2.py <activities.csv> <pilot_sample30.csv> <SEED YYYYMMDD>
Pool = activities in the IATI list minus the 40 pilot projects (10 stage-1 + 30 pilot-draw).
The pool is sorted by code, then shuffled once with random.Random(SEED); the order is the draw order.
Top 15 are the sample; the rest is the reserve, used strictly in order when a drawn project is skipped."""
import csv, random, sys, hashlib
src, s30, seed = sys.argv[1], sys.argv[2], int(sys.argv[3])
stage1 = {'FP001','FP083','FP130','FP137','SAP003','FP005','FP008','FP053','FP288','SAP039'}
pilot = {r['code'] for r in csv.DictReader(open(s30, encoding='utf-8'))} | stage1
rows = list(csv.DictReader(open(src, encoding='utf-8-sig')))
for r in rows: r['code'] = r['iati-identifier'].split('-')[-1]
pool = sorted([r for r in rows if r['code'] not in pilot], key=lambda r: r['code'])
print('activities', len(rows), 'pilot excluded', len(pilot & {r['code'] for r in rows}), 'pool', len(pool))
random.Random(seed).shuffle(pool)
w = csv.writer(open('stage2_draw_order.csv', 'w', newline='', encoding='utf-8'))
w.writerow(['rank','code','title','total-commitment','activity-status','role'])
for i, r in enumerate(pool, 1):
    w.writerow([i, r['code'], r['title'], r['total-commitment'], r['activity-status'], 'sample' if i <= 15 else ('reserve' if i <= 30 else 'later')])
for i, r in enumerate(pool[:20], 1):
    print(i, r['code'], '|', r['title'][:60], '|', r['total-commitment'])
