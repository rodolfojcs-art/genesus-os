/** Datos demo del seed (master prompt §6): 12 proveedores, 8 clientes, 3 productos, 2 máquinas. */

export const DEMO_SUPPLIERS = [
  { name: 'Aceros del Pacífico C.A.', country: 'Chile', categories: ['acero', 'metalmecánica'], contact: { email: 'ventas@acerospacifico.example', telefono: '+56 2 555 0101' }, rating: 4.5, status: 'activo' },
  { name: 'Polímeros Andinos S.A.', country: 'Colombia', categories: ['plásticos', 'inyección'], contact: { email: 'comercial@polandinos.example' }, rating: 4.2, status: 'activo' },
  { name: 'ElectroComponentes MX', country: 'México', categories: ['electrónica', 'PCBs'], contact: { email: 'cotizaciones@ecomx.example' }, rating: 4.7, status: 'activo' },
  { name: 'Rodamientos del Sur', country: 'Argentina', categories: ['rodamientos', 'transmisión'], contact: { email: 'ventas@rodasur.example' }, rating: 4.0, status: 'activo' },
  { name: 'Fundiciones Orinoco', country: 'Venezuela', categories: ['fundición', 'aluminio'], contact: { email: 'contacto@fundorinoco.example' }, rating: 3.9, status: 'activo' },
  { name: 'Cables y Conductores LATAM', country: 'Perú', categories: ['cables', 'eléctrico'], contact: { email: 'ventas@cablatam.example' }, rating: 4.3, status: 'activo' },
  { name: 'Imanes Industriales BR', country: 'Brasil', categories: ['imanes', 'materiales magnéticos'], contact: { email: 'vendas@imasbr.example' }, rating: 4.6, status: 'activo' },
  { name: 'Química Total CR', country: 'Costa Rica', categories: ['químicos', 'recubrimientos'], contact: { email: 'info@quimtotal.example' }, rating: 4.1, status: 'activo' },
  { name: 'Empaques Modernos GT', country: 'Guatemala', categories: ['empaques', 'cartón'], contact: { email: 'ventas@empamod.example' }, rating: 3.8, status: 'activo' },
  { name: 'Tornillería Industrial EC', country: 'Ecuador', categories: ['fijaciones', 'tornillería'], contact: { email: 'pedidos@torniec.example' }, rating: 4.0, status: 'activo' },
  { name: 'Vidrios Técnicos UY', country: 'Uruguay', categories: ['vidrio', 'óptica'], contact: { email: 'ventas@vidriotec.example' }, rating: 4.4, status: 'activo' },
  { name: 'Baterías Continental PA', country: 'Panamá', categories: ['baterías', 'almacenamiento'], contact: { email: 'comercial@batcontinental.example' }, rating: 4.2, status: 'activo' },
] as const;

export const DEMO_CLIENTS = [
  { name: 'Agroindustrias del Llano', segment: 'agroindustria', country: 'Venezuela', contact: { email: 'compras@agrollano.example' }, status: 'activo' },
  { name: 'Minera Cordillera Azul', segment: 'minería', country: 'Perú', contact: { email: 'abastecimiento@cordilleraazul.example' }, status: 'activo' },
  { name: 'Hospital Metropolitano Sur', segment: 'salud', country: 'Colombia', contact: { email: 'logistica@hms.example' }, status: 'activo' },
  { name: 'Cooperativa Eléctrica Rural Andes', segment: 'energía', country: 'Ecuador', contact: { email: 'proyectos@coopandes.example' }, status: 'activo' },
  { name: 'Manufacturas Tigre Norte', segment: 'manufactura', country: 'México', contact: { email: 'compras@tigrenorte.example' }, status: 'activo' },
  { name: 'Constructora Horizonte', segment: 'construcción', country: 'Chile', contact: { email: 'adquisiciones@chorizonte.example' }, status: 'prospecto' },
  { name: 'Universidad Técnica del Caribe', segment: 'educación', country: 'República Dominicana', contact: { email: 'laboratorios@utcaribe.example' }, status: 'prospecto' },
  { name: 'Logística Trans-Andina', segment: 'logística', country: 'Bolivia', contact: { email: 'flota@transandina.example' }, status: 'activo' },
] as const;

export const DEMO_PRODUCTS = [
  {
    name: 'Microturbina eólica GEN-W5',
    sku: 'GEN-W5-001',
    status: 'diseño',
    specs: { potencia_kw: 5, voltaje: '48V DC / 220V AC', diametro_rotor_m: 3.2, uso: 'zonas rurales aisladas' },
  },
  {
    name: 'Controlador de carga solar GEN-S60',
    sku: 'GEN-S60-001',
    status: 'prototipo',
    specs: { corriente_a: 60, topologia: 'MPPT', compatibilidad: '12/24/48V', proteccion: 'IP54' },
  },
  {
    name: 'Banco de baterías modular GEN-B10',
    sku: 'GEN-B10-001',
    status: 'produccion',
    specs: { capacidad_kwh: 10, quimica: 'LiFePO4', modular: true, bms: 'integrado' },
  },
] as const;

export const DEMO_MACHINES = [
  { name: 'CNC-01 · Centro de mecanizado', adapter: 'simulator', config: { unidades_por_minuto: 8 }, status: 'inactiva' },
  { name: 'ENS-01 · Línea de ensamblaje', adapter: 'simulator', config: { unidades_por_minuto: 15 }, status: 'inactiva' },
] as const;
