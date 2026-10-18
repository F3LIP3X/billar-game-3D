# Billar 3D

Juego de billar (bola 8) en el navegador. Vite + TypeScript + Three.js, con física propia.

**Jugar online:** https://billar3d.web.app

## Arrancar

```bash
npm install
npm run dev
```

## Controles

**Escritorio**

- **Ratón**: apuntar
- **Mantener clic izquierdo**: cargar potencia; soltar para tirar
- **Shift + ratón** o **← / →**: ajuste fino del ángulo
- **W A S D** (o el selector de la bola blanca): punto de golpeo — arriba sigue, abajo retrocede, lados dan efecto; **C** lo centra. Vuelve al centro tras cada tiro
- **F**: pantalla completa. La vista elegida (3D, 2D, tras la bola) se recuerda en el navegador
- **Clic derecho**: girar la cámara · **Botón central**: desplazar · **Rueda**: zoom suave hacia el cursor
- **Ctrl** (mantener): cámara libre — arrastrar gira, clic derecho desplaza, rueda zoom; no interactúa con el juego
- **1 / 2 / V** o botones: vistas 3D, 2D (desde arriba) y tras la bola

**Móvil**
- Toca o desliza un dedo sobre la mesa para apuntar o colocar la blanca
- Botón **Mantén para tirar**: cargar potencia y soltar para tirar
- **‹ ›** ajuste fino · **Vista** cámara tras la blanca · dos dedos: girar y zoom

## Reglas (bola 8, basadas en las de la WPA)

- Saque con bola en mano **detrás de la línea de cabecera**.
- Si en el saque entran bolas de un solo grupo, ese grupo es del que saca (regla de la casa, `ASSIGN_GROUP_ON_BREAK` en `src/rules.ts`; en las reglas oficiales la mesa queda abierta). Si entran de los dos, la mesa sigue abierta y el grupo lo decide la primera bola metida después.
- Meter la 8 en el saque no pierde: se recoloca en el punto de pie.
- Falta (blanca dentro, no tocar bola o tocar primero una que no toca): bola en mano para el rival en cualquier sitio (tras una falta en el saque, detrás de la línea).
- Meter la 8 con tu grupo terminado y sin falta gana; antes de tiempo o con falta, pierde.

## Estructura

- `src/physics.ts` — física 2D sobre el plano de la mesa (rodadura, choques, bandas, troneras)
- `src/rules.ts` — reglas simplificadas de bola 8 (grupos, faltas, bola en mano)
- `src/table.ts` — mesa, sala e iluminación
- `src/balls.ts` — bolas (texturas generadas en canvas) y taco
- `src/audio.ts` — sonidos sintetizados con WebAudio (choques, bandas, troneras, turnos); M para silenciar
- `src/main.ts` — escena, entrada y bucle de juego

## Créditos

- Sonidos de golpes, troneras y turno: [Pool And Billiards SFX](https://papapleygames.itch.io/pool-and-billiards) de **Suraj Kispotta** (CC0). Recortados y pasados a mono en `public/sounds/`.

## Contra la máquina

Botón **Contra la máquina** del menú, con tres niveles (fácil, normal, experto). El rival (`src/ai.ts`) genera tiros candidatos a cada tronera, los simula con la misma física y reglas de la partida y elige el mejor; el nivel decide cuántos prueba y cuánto error comete al ejecutarlo.

## Multijugador online

Botón **Jugar online** del menú: se crea una sala con un código de 5 letras (y un enlace `?sala=CÓDIGO`) y el rival se une desde su navegador. Las salas se guardan en Firebase Realtime Database; la sesión es anónima, no hace falta cuenta.

- Cada jugador calcula la misma física (`src/physics.ts`, paso fijo `FIXED_DT`, determinista); quien tira envía solo ángulo, fuerza y efecto, y al acabar publica el estado oficial (posiciones, turno, grupos) al que se ajusta el otro.
- `src/net.ts`: salas, presencia y mensajes. `database.rules.json`: quién puede escribir qué.
- `npm run test:net` prueba el flujo con dos jugadores contra la base de datos real; `npm run deploy:rules` despliega las reglas.

## Publicar

El juego está en Firebase Hosting (proyecto `billar-3d-f3lip3x`, sitio `billar3d`; la dirección antigua redirige a la nueva). Para publicar una versión nueva:

```bash
npm run deploy
```
