import { useCallback, useState } from 'react';

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const STATUSES = ['active', 'trialing', 'past_due', 'canceled'];

const STORAGE_KEY = 'cheating-dev-admin';

function loadStored() {
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : { apiBase: '', adminKey: '' };
    } catch {
        return { apiBase: '', adminKey: '' };
    }
}

function saveStored(apiBase, adminKey) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ apiBase, adminKey }));
}

function decorateRows(list) {
    return list.map(u => ({
        ...u,
        _editPlan: u.plan,
        _editStatus: u.subscriptionStatus,
        _editTrial: u.trialEndsAt || '',
        _editPeriod: u.currentPeriodEnd || '',
        _editDisabled: u.disabled,
    }));
}

export default function App() {
    const [apiBase, setApiBase] = useState(() => loadStored().apiBase);
    const [adminKey, setAdminKey] = useState(() => loadStored().adminKey);
    const [users, setUsers] = useState([]);
    const [message, setMessage] = useState('');
    const [err, setErr] = useState(false);
    const [loading, setLoading] = useState(false);

    const resolvedApi = API_BASE || apiBase.replace(/\/$/, '');

    const apiFetch = useCallback(
        async (path, options = {}) => {
            const key = adminKey.trim();
            if (!key) {
                throw new Error('Admin key required');
            }
            const url = `${resolvedApi}${path}`;
            const res = await fetch(url, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Admin-Key': key,
                    ...options.headers,
                },
            });
            const text = await res.text();
            let data = {};
            try {
                data = text ? JSON.parse(text) : {};
            } catch {
                data = { error: text.slice(0, 200) };
            }
            if (!res.ok) {
                throw new Error(data.error || res.statusText || 'Request failed');
            }
            return data;
        },
        [resolvedApi, adminKey]
    );

    const remember = () => {
        saveStored(apiBase, adminKey);
        setMessage('Saved for this browser tab session.');
        setErr(false);
    };

    const loadUsers = async () => {
        setLoading(true);
        setMessage('');
        setErr(false);
        try {
            const data = await apiFetch('/admin/users');
            setUsers(decorateRows(data.users || []));
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Failed to load');
            setErr(true);
        } finally {
            setLoading(false);
        }
    };

    const saveUser = async u => {
        const body = {
            plan: u._editPlan,
            subscriptionStatus: u._editStatus,
            trialEndsAt: u._editTrial.trim() === '' ? null : u._editTrial.trim(),
            currentPeriodEnd: u._editPeriod.trim() === '' ? null : u._editPeriod.trim(),
            disabled: u._editDisabled,
        };
        setMessage('');
        setErr(false);
        try {
            await apiFetch(`/admin/users/${u.id}`, {
                method: 'PATCH',
                body: JSON.stringify(body),
            });
            setMessage(`Saved user ${u.id}`);
            await loadUsers();
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Save failed');
            setErr(true);
        }
    };

    return (
        <>
            <h1>Cheating-Dev user admin</h1>
            <p className="sub">
                Set <code>ADMIN_API_KEY</code> from server env. Leave API base empty when this UI is served from the same origin as the API (
                <code>/admin/</code>). For <code>vite dev</code>, requests are proxied to port 3847.
            </p>

            <div className="row">
                <label>
                    API base (optional)
                    <input
                        type="text"
                        size={36}
                        placeholder="empty = same origin / VITE_API_BASE"
                        value={apiBase}
                        onChange={e => setApiBase(e.target.value)}
                        autoComplete="off"
                    />
                </label>
                <label>
                    Admin key
                    <input type="password" value={adminKey} onChange={e => setAdminKey(e.target.value)} autoComplete="off" />
                </label>
                <button type="button" className="ghost" onClick={remember}>
                    Remember (tab session)
                </button>
                <button type="button" onClick={loadUsers} disabled={loading}>
                    {loading ? 'Loading…' : 'Load users'}
                </button>
            </div>

            {message ? (
                <p className={`msg${err ? ' err' : ''}`} role="status">
                    {message}
                </p>
            ) : null}

            <table>
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Email</th>
                        <th>Plan</th>
                        <th>Status</th>
                        <th>Trial ends</th>
                        <th>Period end</th>
                        <th>Disabled</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    {users.map(u => (
                        <tr key={u.id}>
                            <td>{u.id}</td>
                            <td>{u.email}</td>
                            <td>
                                <input
                                    value={u._editPlan}
                                    onChange={e =>
                                        setUsers(prev => prev.map(x => (x.id === u.id ? { ...x, _editPlan: e.target.value } : x)))
                                    }
                                />
                            </td>
                            <td>
                                <select
                                    value={u._editStatus}
                                    onChange={e =>
                                        setUsers(prev => prev.map(x => (x.id === u.id ? { ...x, _editStatus: e.target.value } : x)))
                                    }
                                >
                                    {STATUSES.map(s => (
                                        <option key={s} value={s}>
                                            {s}
                                        </option>
                                    ))}
                                </select>
                            </td>
                            <td>
                                <input
                                    placeholder="ISO or empty"
                                    value={u._editTrial}
                                    onChange={e =>
                                        setUsers(prev => prev.map(x => (x.id === u.id ? { ...x, _editTrial: e.target.value } : x)))
                                    }
                                />
                            </td>
                            <td>
                                <input
                                    placeholder="ISO or empty"
                                    value={u._editPeriod}
                                    onChange={e =>
                                        setUsers(prev => prev.map(x => (x.id === u.id ? { ...x, _editPeriod: e.target.value } : x)))
                                    }
                                />
                            </td>
                            <td>
                                <input
                                    type="checkbox"
                                    checked={u._editDisabled}
                                    onChange={e =>
                                        setUsers(prev => prev.map(x => (x.id === u.id ? { ...x, _editDisabled: e.target.checked } : x)))
                                    }
                                />
                            </td>
                            <td>
                                <button type="button" onClick={() => saveUser(u)}>
                                    Save
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </>
    );
}
