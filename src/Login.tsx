// Modo nube: la contraseña. Al entrar se pide antes de mostrar nada; si la sesión vence a mitad de camino, el
// formulario aparece encima de la app sin desmontarla, así no se pierde lo que estabas dibujando.
import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, AUTH_EVENT } from "./api.ts";
import { load } from "./util.ts";

export function CloudGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "in" | "out">("checking");
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    // El tema lo pone App, que todavía no está montada: sin esto, el login sale siempre claro.
    document.documentElement.dataset.theme = load("theme", window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    api.session().then(
      () => (setState("in"), setEntered(true)),
      (err) => setState(err instanceof ApiError && err.status === 401 ? "out" : "in"),
    );
    const onAuth = () => setState("out");
    window.addEventListener(AUTH_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_EVENT, onAuth);
  }, []);

  if (state === "checking") return null;
  return (
    <>
      {(entered || state === "in") && children}
      {state === "out" && (
        <LoginForm
          expired={entered}
          onDone={() => {
            setState("in");
            setEntered(true);
          }}
        />
      )}
    </>
  );
}

function LoginForm({ expired, onDone }: { expired: boolean; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.login(password);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo entrar");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-scrim">
      <form className="login popover" onSubmit={submit}>
        <h1>Serrugrams</h1>
        <p>{expired ? "La sesión venció. Entrá de nuevo para seguir; lo que tenés abierto no se pierde." : "Tus diagramas en la nube."}</p>
        <input className="input" type="password" autoFocus autoComplete="current-password" placeholder="Contraseña" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="login-error">{error}</p>}
        <button className="btn primary" disabled={busy || !password}>
          Entrar
        </button>
      </form>
    </div>
  );
}
