/* ============================================================
   班级投票（v2.79）
   · 管理员可发起；范围 all / boys 由服务端挑人；
     自定义范围只有超管能选人（普通管理员看不到全部名单）。
   · 每人对每个候选人点「投一票」；max_votes 是总票数上限，
     allow_repeat=false 时同一个候选人只能投一次。
   · live_results=false 时，截止前不公开票数；超管始终能看，
     并且能看每个人投了谁（普通管理员和用户看不到）。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8;
  if (!B8) return;

  var logged = false;
  var admin = false;
  var superUser = false;
  var token = '';
  var peopleLoaded = false;
  var people = [];
  var activeBallotPoll = 0;
  var activeBallot = null;

  function errText(err, fallback) {
    return err && err.message ? err.message : fallback;
  }

  var els = {};

  function $(id) { return document.getElementById(id); }

  function fmt(n) { return Number(n || 0).toLocaleString('zh-CN'); }

  function dt(iso) {
    if (!iso) return '不限';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  }

  function setStatus(msg, err) {
    if (!els.status) return;
    els.status.textContent = msg || '';
    els.status.className = 'form-status' + (err ? ' err' : '');
  }

  function scopeLabel(s) {
    return s === 'boys' ? '男生' : (s === 'custom' ? '自定义范围' : '全部同学');
  }

  function authInfo() {
    try {
      logged = !!(B8.auth && B8.auth.isLogged && B8.auth.isLogged());
      admin = !!(B8.auth && B8.auth.isAdmin && B8.auth.isAdmin());
      superUser = !!(B8.auth && B8.auth.isSuper && B8.auth.isSuper());
      token = logged && B8.auth.token ? (B8.auth.token() || '') : '';
    } catch (e) {
      logged = admin = superUser = false;
      token = '';
    }
  }

  /* ============================================================
     列表
     ============================================================ */

  function loadPolls() {
    authInfo();
    if (els.createBtn) els.createBtn.hidden = !admin;

    if (!logged || !B8.sb || !B8.sb.ready) {
      renderPolls([]);
      if (els.empty) {
        els.empty.hidden = false;
        els.empty.textContent = !logged ? '登录后才能看投票。' :
          '数据库还没接上，投票暂时不能用。';
      }
      return;
    }

    setStatus('正在读投票…');
    B8.sb.rpc('b8_poll_list', { p_token: token }).then(function (rows) {
      setStatus('');
      renderPolls(Array.isArray(rows) ? rows : []);
    }).catch(function (err) {
      setStatus('投票没读出来：' + (err && err.message ? err.message : '网络异常'), true);
      renderPolls([]);
      if (els.list) {
        var msg = err && err.message ? err.message : '';
        if (/Could not find the function|schema cache|does not exist/i.test(msg)) {
          if (els.empty) {
            els.empty.hidden = false;
            els.empty.textContent = '投票要更新数据库：请先跑一遍 supabase/install-all.sql。';
          }
        }
      }
    });
  }

  function renderPolls(polls) {
    if (!els.list) return;
    els.list.innerHTML = '';
    if (!polls.length) {
      if (els.empty) {
        els.empty.hidden = false;
        els.empty.textContent = admin
          ? '还没有投票，点右上角「创建投票」发起第一个。'
          : '还没有投票。';
      }
      return;
    }
    if (els.empty) els.empty.hidden = true;

    polls.forEach(function (p) {
      els.list.appendChild(renderPoll(p));
    });
  }

  function renderPoll(p) {
    var card = document.createElement('article');
    card.className = 'poll-item';

    var head = document.createElement('div');
    head.className = 'poll-item-head';

    var h = document.createElement('h3');
    h.textContent = p.title || '未命名投票';
    head.appendChild(h);

    var tags = document.createElement('div');
    tags.className = 'poll-tags';
    tags.appendChild(tag(scopeLabel(p.scope)));
    tags.appendChild(tag('每人 ' + p.max_votes + ' 票'));
    tags.appendChild(tag(p.allow_repeat ? '可重复投' : '同一人只能投一次'));
    tags.appendChild(tag(p.live_results ? '实时公布' : '截止后公布'));
    if (p.deadline) tags.appendChild(tag('截止 ' + dt(p.deadline)));
    if (!p.can_vote) tags.appendChild(tag('已截止'));
    head.appendChild(tags);
    card.appendChild(head);

    if (p.description) {
      var desc = document.createElement('p');
      desc.className = 'poll-desc';
      desc.textContent = p.description;
      card.appendChild(desc);
    }

    var mine = document.createElement('p');
    mine.className = 'poll-meta';
    mine.textContent = '你已投 ' + fmt(p.my_votes) + ' / ' + p.max_votes + ' 票' +
      (p.remaining > 0 ? '，还可以投 ' + fmt(p.remaining) + ' 票' : '，已投满');
    card.appendChild(mine);

    if (!p.results_visible) {
      var hidden = document.createElement('p');
      hidden.className = 'poll-meta poll-secret';
      hidden.textContent = '结果暂不公布，截止后自动揭晓。';
      card.appendChild(hidden);
    }

    var ul = document.createElement('ul');
    ul.className = 'poll-candidates';

    var cands = Array.isArray(p.candidates) ? p.candidates : [];
    cands.forEach(function (c, i) {
      var li = document.createElement('li');
      li.className = 'poll-cand';

      var no = document.createElement('span');
      no.className = 'poll-cand-no';
      no.textContent = String(i + 1).padStart(2, '0');
      li.appendChild(no);

      var name = document.createElement('span');
      name.className = 'poll-cand-name';
      name.textContent = c.name || '同学';
      li.appendChild(name);

      var count = document.createElement('span');
      count.className = 'poll-cand-count';
      if (p.results_visible && c.votes != null) {
        count.textContent = fmt(c.votes) + ' 票';
      } else {
        count.textContent = '—';
      }
      li.appendChild(count);

      if (c.my_votes > 0) {
        var my = document.createElement('span');
        my.className = 'poll-cand-mine';
        my.textContent = '我 ' + fmt(c.my_votes);
        li.appendChild(my);
      }

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ghost sm poll-vote-btn';
      btn.textContent = '投一票';
      btn.disabled = !p.can_vote || p.remaining <= 0 ||
        (!p.allow_repeat && c.my_votes > 0);
      B8.on(btn, 'click', function () {
        vote(p, c, btn);
      });
      li.appendChild(btn);

      ul.appendChild(li);
    });
    card.appendChild(ul);

    if (superUser) {
      var actions = document.createElement('div');
      actions.className = 'poll-super-actions';

      var superBtn = document.createElement('button');
      superBtn.type = 'button';
      superBtn.className = 'btn ghost sm poll-super-btn';
      superBtn.textContent = '看投票明细';
      B8.on(superBtn, 'click', function () { showBallots(p); });
      actions.appendChild(superBtn);

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn ghost sm poll-super-danger';
      delBtn.textContent = '删除投票';
      B8.on(delBtn, 'click', function () {
        B8.confirm('删除「' + (p.title || '这个投票') + '」？候选人、票数都会一起删掉，不能恢复。', {
          title: '删除投票',
          okText: '删除',
          danger: true
        }).then(function (yes) {
          if (!yes) return;
          B8.sb.rpc('b8_poll_delete', { p_token: token, p_poll_id: p.id }).then(function () {
            B8.toast('投票已删除');
            loadPolls();
          }).catch(function (err) {
            B8.toast(errText(err, '删除失败'));
          });
        });
      });
      actions.appendChild(delBtn);

      card.appendChild(actions);
    }

    return card;
  }

  function tag(text) {
    var s = document.createElement('span');
    s.className = 'tag plain';
    s.textContent = text;
    return s;
  }

  function vote(p, c, btn) {
    if (!p.can_vote) return;
    btn.disabled = true;
    B8.sb.rpc('b8_poll_vote', {
      p_token: token, p_poll_id: p.id, p_candidate_id: c.id, p_weight: 1
    }).then(function () {
      B8.toast('投给 ' + c.name + ' 了');
      loadPolls();
    }).catch(function (err) {
      btn.disabled = false;
      setStatus('投票没成功：' + (err && err.message ? err.message : '网络异常'), true);
    });
  }

  /* ============================================================
     创建投票
     ============================================================ */

  function openCreate() {
    if (!admin) return;
    if (!els.modal) return;
    authInfo();
    els.modal.hidden = false;
    if (els.formStatus) els.formStatus.textContent = '';
    if (els.title) els.title.value = '';
    if (els.desc) els.desc.value = '';
    if (els.max) els.max.value = '1';
    if (els.repeat) els.repeat.checked = false;
    if (els.live) els.live.checked = true;
    if (els.deadline) els.deadline.value = '';
    if (els.scope) els.scope.value = 'all';
    if (els.people) els.people.hidden = true;
    var customOpt = els.scope ? els.scope.querySelector('option[value="custom"]') : null;
    if (customOpt) customOpt.hidden = !superUser;

    if (superUser && !peopleLoaded) loadPeople();
  }

  function closeCreate() {
    if (els.modal) els.modal.hidden = true;
  }

  function loadPeople() {
    if (!superUser || peopleLoaded) return;
    peopleLoaded = true;
    B8.sb.rpc('b8_poll_people', { p_token: token }).then(function (rows) {
      people = Array.isArray(rows) ? rows : [];
      renderPeople();
    }).catch(function (err) {
      peopleLoaded = false;
      if (els.formStatus) els.formStatus.textContent =
        '名单没读出来：' + (err && err.message ? err.message : '网络异常');
    });
  }

  function renderPeople() {
    if (!els.peopleGrid) return;
    els.peopleGrid.innerHTML = '';
    people.forEach(function (m) {
      var lab = document.createElement('label');
      lab.className = 'poll-person';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = m.member_no;
      lab.appendChild(cb);
      var span = document.createElement('span');
      span.textContent = m.name + (m.gender === 'm' ? ' · 男' : (m.gender === 'f' ? ' · 女' : ''));
      lab.appendChild(span);
      els.peopleGrid.appendChild(lab);
    });
  }

  function selectedPeople() {
    if (!els.peopleGrid) return [];
    return B8.qsa('input[type="checkbox"]:checked', els.peopleGrid).map(function (cb) {
      return cb.value;
    });
  }

  function toIso(v) {
    if (!v) return null;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function submitCreate() {
    if (!admin) return;
    var title = els.title ? els.title.value.trim() : '';
    var scope = els.scope ? els.scope.value : 'all';
    var max = els.max ? Number(els.max.value) || 0 : 0;
    var candidates = scope === 'custom' ? selectedPeople() : null;

    if (!title) { setFormStatus('主题不能为空。', true); return; }
    if (max < 1 || max > 20) { setFormStatus('每人可投要 1–20。', true); return; }
    if (scope === 'custom' && (!candidates || !candidates.length)) {
      setFormStatus('自定义范围至少要选一个候选人。', true);
      return;
    }

    var args = {
      p_token: token,
      p_title: title,
      p_desc: els.desc ? els.desc.value.trim() : '',
      p_scope: scope,
      p_max_votes: max,
      p_allow_repeat: !!(els.repeat && els.repeat.checked),
      p_live_results: !!(els.live && els.live.checked),
      p_deadline: toIso(els.deadline ? els.deadline.value : '')
    };
    if (candidates) args.p_candidates = candidates;

    if (els.submit) els.submit.disabled = true;
    setFormStatus('正在发起…');
    B8.sb.rpc('b8_poll_create', args).then(function () {
      if (els.submit) els.submit.disabled = false;
      closeCreate();
      B8.toast('投票已发起');
      loadPolls();
    }).catch(function (err) {
      if (els.submit) els.submit.disabled = false;
      setFormStatus('没发起成功：' + (err && err.message ? err.message : '网络异常'), true);
    });
  }

  function setFormStatus(msg, err) {
    if (!els.formStatus) return;
    els.formStatus.textContent = msg || '';
    els.formStatus.className = 'form-status' + (err ? ' err' : '');
  }

  /* ============================================================
     超管看谁投了谁
     ============================================================ */

  function showBallots(p) {
    if (!superUser) return;
    activeBallotPoll = p.id;
    activeBallot = p;
    if (els.ballotsModal) els.ballotsModal.hidden = false;
    if (els.ballotsTitle) els.ballotsTitle.textContent = '投票明细 · ' + p.title;
    loadBallots(p.id);
  }

  function loadBallots(pollId) {
    if (els.ballotsList) els.ballotsList.textContent = '正在读…';
    B8.sb.rpc('b8_poll_ballots', { p_token: token, p_poll_id: pollId }).then(function (rows) {
      renderBallots(Array.isArray(rows) ? rows : []);
    }).catch(function (err) {
      if (els.ballotsList) els.ballotsList.textContent =
        '读不出来：' + (err && err.message ? err.message : '网络异常');
    });
  }

  function renderBallots(rows) {
    if (!els.ballotsList) return;
    els.ballotsList.innerHTML = '';
    if (!rows.length) {
      els.ballotsList.textContent = '还没有人投票。';
      return;
    }

    var head = document.createElement('p');
    head.className = 'form-note';
    head.textContent = '可以直接改候选人和票数，或删掉这一条。改完立刻生效。';
    els.ballotsList.appendChild(head);

    var poll = activeBallot;
    var cands = poll && Array.isArray(poll.candidates) ? poll.candidates : [];
    var max = poll && poll.max_votes ? poll.max_votes : 20;

    rows.forEach(function (r) {
      var box = document.createElement('div');
      box.className = 'poll-ballot-row poll-ballot-edit';

      var who = document.createElement('b');
      who.className = 'poll-ballot-who';
      who.textContent = r.voter_name || r.voter_no;
      box.appendChild(who);

      var sel = document.createElement('select');
      sel.className = 'poll-ballot-select';
      cands.forEach(function (c) {
        var o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.name;
        if (String(c.id) === String(r.candidate_id)) o.selected = true;
        sel.appendChild(o);
      });
      box.appendChild(sel);

      var weight = document.createElement('input');
      weight.type = 'number';
      weight.className = 'poll-ballot-weight';
      weight.min = '1';
      weight.max = String(max);
      weight.value = String(r.weight || 1);
      box.appendChild(weight);

      var save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn ghost sm';
      save.textContent = '保存';
      B8.on(save, 'click', function () {
        var cid = Number(sel.value);
        var w = Number(weight.value);
        if (!cid || !w || w < 1 || w > max) {
          B8.toast('票数要在 1–' + max + ' 之间');
          return;
        }
        B8.sb.rpc('b8_poll_ballot_update', {
          p_token: token,
          p_vote_id: r.vote_id,
          p_candidate_id: cid,
          p_weight: w
        }).then(function () {
          B8.toast('已修改');
          loadBallots(activeBallotPoll);
          loadPolls();
        }).catch(function (err) {
          B8.toast(errText(err, '修改失败'));
        });
      });
      box.appendChild(save);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn ghost sm poll-ballot-del';
      del.textContent = '删除';
      B8.on(del, 'click', function () {
        B8.confirm('删掉 ' + (r.voter_name || r.voter_no) + ' 这一条投票？', {
          title: '删除投票记录',
          okText: '删除',
          danger: true
        }).then(function (yes) {
          if (!yes) return;
          B8.sb.rpc('b8_poll_ballot_delete', {
            p_token: token,
            p_vote_id: r.vote_id
          }).then(function () {
            B8.toast('已删除');
            loadBallots(activeBallotPoll);
            loadPolls();
          }).catch(function (err) {
            B8.toast(errText(err, '删除失败'));
          });
        });
      });
      box.appendChild(del);

      els.ballotsList.appendChild(box);
    });
  }

  function closeBallots() {
    if (els.ballotsModal) els.ballotsModal.hidden = true;
    activeBallotPoll = 0;
    activeBallot = null;
  }
  /* ============================================================
     启动
     ============================================================ */

  function boot() {
    els.list = $('poll-list');
    els.empty = $('poll-empty');
    els.status = $('vote-status');
    els.createBtn = $('vote-create');
    els.modal = $('poll-create-modal');
    els.title = $('poll-title');
    els.desc = $('poll-desc');
    els.scope = $('poll-scope');
    els.max = $('poll-max');
    els.repeat = $('poll-repeat');
    els.live = $('poll-live');
    els.deadline = $('poll-deadline');
    els.people = $('poll-people');
    els.peopleGrid = $('poll-people-grid');
    els.formStatus = $('poll-form-status');
    els.submit = $('poll-create-submit');
    els.ballotsModal = $('poll-ballots-modal');
    els.ballotsList = $('poll-ballots-list');
    els.ballotsTitle = $('poll-ballots-title');

    if (!els.list) return;

    B8.on(els.createBtn, 'click', openCreate);
    B8.on($('poll-create-close'), 'click', closeCreate);
    B8.on($('poll-create-cancel'), 'click', closeCreate);
    B8.on(els.submit, 'click', submitCreate);
    B8.on($('poll-ballots-close'), 'click', closeBallots);

    B8.on(els.scope, 'change', function () {
      var custom = els.scope.value === 'custom';
      if (els.people) els.people.hidden = !custom;
      if (custom) loadPeople();
    });

    B8.on(document, 'keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (els.ballotsModal && !els.ballotsModal.hidden) { closeBallots(); return; }
      if (els.modal && !els.modal.hidden) closeCreate();
    });

    if (els.modal) {
      B8.on(els.modal, 'click', function (ev) {
        if (ev.target === els.modal) closeCreate();
      });
    }
    if (els.ballotsModal) {
      B8.on(els.ballotsModal, 'click', function (ev) {
        if (ev.target === els.ballotsModal) closeBallots();
      });
    }

    B8.vote = {
      reload: loadPolls,
      state: function () {
        return { logged: logged, admin: admin, super: superUser, people: people.length };
      }
    };

    if (B8.auth && B8.auth.ready) B8.auth.ready(loadPolls);
    else loadPolls();
    document.addEventListener('b8:auth', loadPolls);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
