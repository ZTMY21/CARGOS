import { renderCargoLineChart } from './cargo-line-chart.js';

const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const MONTH_NAMES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const fmt = value => Number(value).toLocaleString('es-PE');

/**
 * Dashboard administrativo (solo presentación).
 * La misma consulta read-only del detalle Iron Mountain alimenta este gráfico.
 * No realiza escrituras, ni confunde cajas físicas con cargos.
 */
export function mountImDashboard() {
  const root = document.getElementById('imDashboard');
  if (!root) return () => {};
  const byMonth = root.querySelector('#imDashboardByMonth');
  const byYear = root.querySelector('#imDashboardByYear');
  const select = root.querySelector('#imDashboardYear');
  const yearWrap = root.querySelector('#imDashboardYearWrap');
  const surface = root.querySelector('#imDashboardChart');
  const legend = root.querySelector('#imDashboardLegend');
  const count = root.querySelector('#imDashboardTotal');
  const title = root.querySelector('#imDashboardPeriod');
  const detail = root.querySelector('#imDashboardDescription');
  const status = root.querySelector('#imDashboardStatus');
  const updated = root.querySelector('#imDashboardLast');
  const modeButtons = [byMonth, byYear];
  let mode = 'months';
  let selectedYear = null;
  let snapshot = null;
  let fetchError = '';

  function render() {
    byMonth.setAttribute('aria-pressed', String(mode === 'months'));
    byYear.setAttribute('aria-pressed', String(mode === 'years'));
    yearWrap.hidden = mode !== 'months';
    if (!snapshot) {
      surface.replaceChildren();
      legend.replaceChildren();
      count.textContent = '—';
      title.textContent = 'Envíos a Iron Mountain';
      detail.textContent = 'La gráfica utiliza el historial real de cajas físicas enviadas.';
      updated.textContent = '';
      status.hidden = false;
      status.textContent = fetchError || 'Consultando envíos históricos y nuevos…';
      return;
    }

    const validYears = snapshot.annual.map(row => Number(row.year));
    if (selectedYear === null || !validYears.includes(selectedYear)) selectedYear = snapshot.currentYear;
    const key = validYears.join(',');
    if (select.dataset.years !== key) {
      select.replaceChildren();
      for (const year of validYears.slice().reverse()) {
        const option = document.createElement('option');
        option.value = String(year);
        option.textContent = String(year);
        select.append(option);
      }
      select.dataset.years = key;
    }
    select.value = String(selectedYear);
    const row = snapshot.annual.find(item => item.year === selectedYear);
    const yearNow = snapshot.currentYear;
    const monthNow = snapshot.currentMonth;
    const current = selectedYear === yearNow;

    const categories = mode === 'months'
      ? MONTHS.slice(0, current ? monthNow : 12)
      : snapshot.annual.map(item => String(item.year));
    const values = mode === 'months'
      ? (row?.months || []).slice(0, categories.length)
      : snapshot.annual.map(item => item.count);
    const total = mode === 'months'
      ? (row?.count ?? 0)
      : snapshot.annual.reduce((sum, item) => sum + item.count, 0);
    status.hidden = true;
    count.textContent = fmt(total);
    title.textContent = mode === 'months'
      ? 'Evolución mensual · ' + selectedYear
      : 'Evolución anual · ' + validYears[0] + '–' + validYears.at(-1);
    detail.textContent = mode === 'months'
      ? (current
        ? 'Enero–' + MONTH_NAMES[monthNow - 1] + ' de ' + selectedYear
          + ' · ' + MONTH_NAMES[monthNow - 1] + ' es el mes actual'
        : 'Enero–diciembre de ' + selectedYear)
      : 'Cajas físicas enviadas en el histórico completo';
    updated.textContent = mode === 'months'
      ? (row?.latest ? 'Último envío registrado del año: ' + row.latest : 'Sin fechas de envío registradas ese año')
      : 'Conteo por fecha efectiva de envío a Iron Mountain';

    renderCargoLineChart(surface, legend, categories, [
      { label: 'Cajas enviadas a Iron Mountain', color: '#c6253e', values, width: 3 }
    ], {
      showLabels: true,
      unit: 'cajas',
      highlightIndex: mode === 'months' && current ? monthNow - 1 : null
    });
  }

  modeButtons.forEach(button => button.addEventListener('click', () => {
    mode = button === byMonth ? 'months' : 'years';
    render();
  }));
  select.addEventListener('change', () => {
    selectedYear = Number(select.value);
    render();
  });
  render();
  return (summary, error = '') => {
    snapshot = summary || null;
    fetchError = error;
    render();
  };
}
