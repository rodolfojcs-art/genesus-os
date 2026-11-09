# Open WebUI — activación (1 paso pendiente: habilitar WSL)

Open WebUI ya está configurado (`docker-compose.yml`) y apunta a GENESUS, **no** a Anthropic.
Lo único que falta es habilitar la virtualización que Docker necesita en tu PC.

## Diagnóstico (verificado el 2026-06-12)

- Docker Desktop **instalado** (v4.77) ✅
- Docker reporta: **"Virtualization support not detected"** → el backend WSL2 no puede arrancar.
- Causa exacta: **WSL no está instalado** en este equipo.

## Solución (2 minutos + 1 reinicio) — requiere administrador

1. Abre **PowerShell como administrador** (clic derecho → "Ejecutar como administrador").
2. Ejecuta:
   ```powershell
   wsl --install
   ```
   Esto habilita "Virtual Machine Platform" + WSL2 e instala Ubuntu.
3. **Reinicia** el equipo (Windows lo pedirá).
4. Tras reiniciar, abre **Docker Desktop** una vez (acepta el acuerdo si lo pide) y espera a que el motor diga "Engine running".
5. Levanta Open WebUI:
   ```powershell
   cd C:\Users\rodol\genesus-os
   docker compose -f openwebui\docker-compose.yml up -d
   ```
6. Abre **http://localhost:3000** → en el selector de modelo elige **genesus-personal**.

> Si después de `wsl --install` Docker sigue diciendo lo mismo, entra a la BIOS/UEFI y
> activa la virtualización (Intel **VT-x** / AMD **SVM**). Suele estar en
> Advanced → CPU Configuration.

## ¿No quieres Docker?

No lo necesitas para usar tu IA. La app GENESUS ya tiene su propio chat
(**GENESUS Personal**) con la misma memoria permanente y la misma Bóveda.
Open WebUI solo es una interfaz alternativa (voz, multimodal, multiusuario).
