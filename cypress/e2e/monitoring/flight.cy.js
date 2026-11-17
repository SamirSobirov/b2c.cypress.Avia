// Страница поиска шумит ResizeObserver'ом при открытии календаря и дропдаунов —
// это не ошибка приложения, но Cypress валит на ней тест.
Cypress.on('uncaught:exception', (err) => {
  if (err.message.includes('ResizeObserver')) return false;
});

describe('Flight Search Flow', () => {

  const EMAIL = Cypress.env('LOGIN_EMAIL');
  const PASSWORD = Cypress.env('LOGIN_PASSWORD');

  // 1. ИЗМЕНЕНО НАПРАВЛЕНИЕ: Ташкент (TAS) -> Москва (MOW)
  const ROUTE = {
    FROM: 'TAS',   // Ташкент, аэропорт имени Ислама Каримова
    TO: 'MOW',     // Москва (все аэропорты / мультигородской узел)
  };

  // --- ДИНАМИЧЕСКИЙ РАСЧЁТ ДАТЫ (сегодня + 3 дня) ---
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + 3);

  const DEPART = {
    YEAR: targetDate.getFullYear().toString(),
    // Массив для перевода месяца в трехбуквенное сокращение на русском (соответствует UI приложения)
    MONTH: ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'][targetDate.getMonth()],
    MONTH_NUM: String(targetDate.getMonth() + 1).padStart(2, '0'),   // формат 'MM' для проверки URL
    DAY: String(targetDate.getDate()),                               // число дня без ведущего нуля, как в aria-label календаря
  };

  const OFFER_CARD = 'article';

  const T = {
    PAGE: 120000,
    UI: 30000,
    API: 45000,
    LOGOUT: 30000,
    SEARCH: 90000,   // POST /search/flights + первый poll
    RESULTS: 30000,
  };

  const PAUSE = {
    MODAL: 1000,
    FIELD: 500,
    SUBMIT: 800,
    SETTLE: 2000,
  };

  const firstCalendar = () =>
    cy.get('.p-datepicker-panel .p-datepicker-calendar', { timeout: T.UI }).first();

  const panel = () => cy.get('.p-datepicker-panel', { timeout: T.UI });

  const pickAirport = (selector, code) => {
    cy.fillInput(selector, code, { timeout: T.UI });

    cy.get('li.p-autocomplete-option', { timeout: T.UI })
      .filter(':visible')
      .contains(code)
      .click({ timeout: T.UI });

    cy.get(selector, { timeout: T.UI }).should('not.have.value', '');
    cy.wait(PAUSE.FIELD);
  };

  before(() => {
    expect(EMAIL, 'секрет CYPRESS_LOGIN_EMAIL не задан').to.be.a('string').and.not.be.empty;
    expect(PASSWORD, 'секрет CYPRESS_LOGIN_PASSWORD не задан').to.be.a('string').and.not.be.empty;
  });

  beforeEach(() => {
    cy.writeFile('auth_api_status.txt', 'UNKNOWN');
    cy.writeFile('api_status.txt', 'UNKNOWN');
    cy.writeFile('offers_count.txt', 'N/A');
  });

  it('Авторизация и поиск авиабилетов', () => {
    cy.viewport(1280, 800);

    // 1. ПЕРЕХВАТ API
    cy.intercept({ method: 'POST', url: '**/login**' }).as('apiAuth');
    cy.intercept({ method: 'POST', url: '**/api/v1/search/flights' }).as('apiSearch');
    cy.intercept({ method: 'GET', url: '**/api/v1/search/flights/*/poll**' }).as('apiPoll');

    // 2. ПЕРЕХОД НА ГЛАВНУЮ
    cy.visit('https://metatrip.asia/ru/', { timeout: T.PAGE });

    // 3. ОТКРЫТИЕ МОДАЛКИ "ВХОД В ПРОФИЛЬ"
    cy.clickUntilVisible('nav button', '.p-dialog', {
      text: 'Войти',
      timeout: T.UI,
      pause: PAUSE.MODAL,
    });

    cy.get('.p-dialog', { timeout: T.UI }).should('be.visible').within(() => {
      cy.contains('Вход в профиль', { timeout: T.UI }).should('be.visible');

      // 4. ВВОД ПОЧТЫ
      cy.fillInput('input[name="email"]', EMAIL, { timeout: T.UI });
      cy.wait(PAUSE.FIELD);

      // 5. ВВОД ПАРОЛЯ
      cy.fillInput('input[name="password"]', PASSWORD, { timeout: T.UI });
      cy.wait(PAUSE.SUBMIT);

      // 6. КЛИК "ВОЙТИ"
      cy.get('button[aria-label="Войти"]', { timeout: T.UI })
        .should('be.visible')
        .and('have.attr', 'data-p-disabled', 'false')
        .click({ timeout: T.UI });
    });

    // 7. УМНАЯ ПРОВЕРКА ОТВЕТА СЕРВЕРА
    cy.wait('@apiAuth', { timeout: T.API }).then((interception) => {
      const statusCode = interception.response?.statusCode || 500;
      cy.writeFile('auth_api_status.txt', statusCode.toString());

      if (statusCode >= 400) {
        throw new Error(`🆘 Ошибка сервера при авторизации: HTTP ${statusCode}`);
      }
    });

    // 8. ПРОВЕРКА УСПЕШНОГО ВХОДА (UI)
    cy.get('.p-dialog', { timeout: T.LOGOUT }).should('not.exist');
    cy.get('body', { timeout: T.UI })
      .should('not.contain', 'Неверный логин')
      .and('not.contain', 'Ошибка');

    cy.log('✅ Авторизация прошла успешно');

    // 9. ОТКУДА (TAS)
    pickAirport('input#search-from', ROUTE.FROM);

    // 10. КУДА (MOW)
    pickAirport('input#search-to', ROUTE.TO);

    // 11. ОТКРЫТИЕ КАЛЕНДАРЯ "КОГДА"
    cy.get('body').then(($body) => {
      if ($body.find('.p-datepicker-panel').length === 0) {
        cy.contains('button', 'Когда', { timeout: T.UI }).should('be.visible').click({ timeout: T.UI });
      }
    });
    cy.get('.p-datepicker-panel', { timeout: T.UI }).should('be.visible');

    // 12. ГОД: выбираем динамически рассчитанный год
    firstCalendar()
      .find('button.p-datepicker-select-year')
      .should('be.visible')
      .click({ timeout: T.UI });

    panel()
      .find('.p-datepicker-year-view span.p-datepicker-year')
      .not('.p-disabled')
      .contains(new RegExp(`^\\s*${DEPART.YEAR}\\s*$`))
      .click({ timeout: T.UI });

    // 13. МЕСЯЦ: выбираем месяц (например, "Июн", "Мар" и т.д.)
    panel()
      .find('.p-datepicker-month-view span.p-datepicker-month')
      .not('.p-disabled')
      .contains(new RegExp(`^\\s*${DEPART.MONTH}\\s*$`))
      .click({ timeout: T.UI });

    // 14. ДЕНЬ: выбираем день (сегодня + 3 дня)
    firstCalendar()
      .find(`td[aria-label="${DEPART.DAY}"] span.p-datepicker-day`)
      .not('.p-disabled')
      .first()
      .click({ timeout: T.UI });

    cy.scrollTo('top');
    cy.wait(PAUSE.SUBMIT);

    // Проверка отображения выбранной даты в интерфейсе
    cy.contains('button', new RegExp(`${DEPART.DAY}`), { timeout: T.UI }).should('be.visible');

    // 15. ПОИСК
    cy.contains('button', 'Поиск', { timeout: T.UI })
      .should('be.visible')
      .click({ timeout: T.UI });

    // 16. ПРОВЕРКА URL
    cy.url({ timeout: T.PAGE })
      .should('include', '/flights')
      .and('include', `from=${ROUTE.FROM}`)
      .and('include', `to=${ROUTE.TO}`)
      .and('include', `dd=${DEPART.YEAR}-${DEPART.MONTH_NUM}-${DEPART.DAY.padStart(2, '0')}`);

    // 17. СТАТУС ПОИСКОВОГО API
    cy.wait('@apiSearch', { timeout: T.SEARCH }).then((interception) => {
      const statusCode = interception.response?.statusCode || 500;
      cy.writeFile('api_status.txt', statusCode.toString());

      if (statusCode >= 400) {
        throw new Error(`🆘 Ошибка сервера при поиске перелётов: HTTP ${statusCode}`);
      }
    });

    cy.wait('@apiPoll', { timeout: T.SEARCH }).then((interception) => {
      const statusCode = interception.response?.statusCode || 500;

      if (statusCode >= 400) {
        throw new Error(`🆘 Ошибка при получении результатов (poll): HTTP ${statusCode}`);
      }
    });

    cy.log('✅ Поиск запущен');

    // 18. ПОДСЧЁТ ОФФЕРОВ
    cy.countWhenStable(OFFER_CARD, { timeout: T.RESULTS, settle: PAUSE.SETTLE }).then((count) => {
      cy.writeFile('offers_count.txt', count.toString());
      cy.log(`✅ Найдено офферов: ${count}`);

      expect(count, 'офферов в выдаче').to.be.greaterThan(0);
    });
    cy.screenshot('after-search', { capture: 'viewport' });
  });
});