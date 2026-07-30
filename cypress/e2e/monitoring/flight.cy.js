// Страница поиска шумит ResizeObserver'ом при открытии календаря и дропдаунов —
// это не ошибка приложения, но Cypress валит на ней тест.
Cypress.on('uncaught:exception', (err) => {
  if (err.message.includes('ResizeObserver')) return false;
});

describe('Flight Search Flow', () => {

  const EMAIL = Cypress.env('LOGIN_EMAIL');
  const PASSWORD = Cypress.env('LOGIN_PASSWORD');

  // Маршрут поиска — менять здесь.
  // Задаём IATA-кодами, а не названиями городов: по коду автокомплит отдаёт
  // ровно один нужный аэропорт, а по названию — все аэропорты города
  // (на "Нью-Йорк" их четыре: EWR, ISP, JFK, LGA), и выбор станет случайным.
  const ROUTE = {
    FROM: 'JFK',   // Нью-Йорк, аэропорт имени Джона Кеннеди
    TO: 'TNR',     // Антананариву, аэропорт Ивато
  };

  // Дата вылета. Выбираем через заголовок календаря (год → месяц → день),
  // а не листанием месяцев: от текущего месяца до июня 2028 это ~23 клика "вперёд".
  const DEPART = {
    YEAR: '2028',
    MONTH: 'Июн',      // подпись в month-view, не полное название месяца
    MONTH_NUM: '06',   // тот же месяц для проверки dd=ГГГГ-ММ-ДД в URL результатов
    DAY: '24',
  };

  // Карточка оффера на странице результатов. Семантический тег без своего
  // класса: Tailwind-классы у карточки меняются при любой правке вёрстки, а
  // data-v-* — это хеш scoped-стилей Vue, он новый после каждой сборки.
  // Проверено на выдаче: 20 article = 20 карточек = 20 кнопок "Выбрать",
  // других article на странице нет.
  const OFFER_CARD = 'article';

  const T = {
    PAGE: 120000,
    UI: 30000,
    API: 45000,
    LOGOUT: 30000,
    SEARCH: 90000,   // POST /search/flights + первый poll: метапоиск опрашивает партнёров
    RESULTS: 30000,  // бюджет на наполнение выдачи, после которого она считается пустой
  };

  const PAUSE = {
    MODAL: 1000,
    FIELD: 500,
    SUBMIT: 800,
    SETTLE: 2000,   // окно, за которое проверяем, что выдача перестала пополняться
  };

  // Календарь показывает два месяца рядом: заголовки (select-year / select-month)
  // и таблицы дней есть в DOM дважды, по одной на каждый .p-datepicker-calendar.
  // Работаем с левым — в нём открывается нужный месяц.
  const firstCalendar = () =>
    cy.get('.p-datepicker-panel .p-datepicker-calendar', { timeout: T.UI }).first();

  // Сетки годов и месяцев, наоборот, общие на всю панель и лежат вне
  // .p-datepicker-calendar — искать их внутри календаря бесполезно.
  const panel = () => cy.get('.p-datepicker-panel', { timeout: T.UI });

  // Ввод аэропорта в автокомплит + выбор подсказки.
  // Без клика по подсказке форма считает поле незаполненным: набранный текст
  // остаётся текстом, а не выбранным аэропортом, и поиск не стартует.
  //
  // Ждём именно li.p-autocomplete-option: подсказки приходят с бэкенда, а до
  // ответа в панели висит заглушка li.p-autocomplete-empty-message
  // ("No results found"). Она тоже попадает под ul[role="listbox"] li, клик по
  // ней проходит без ошибки и ничего не выбирает — так и терялись оба поля,
  // а "Поиск" молча не стартовал.
  //
  // Подсказку ищем по коду в тексте (например "… Международный аэропорт имени
  // Джона Кеннеди JFK"): aria-label у неё — только город, у всех аэропортов
  // города он одинаковый.
  const pickAirport = (selector, code) => {
    cy.fillInput(selector, code, { timeout: T.UI });

    cy.get('li.p-autocomplete-option', { timeout: T.UI })
      .filter(':visible')
      .contains(code)
      .click({ timeout: T.UI });

    // Аэропорт действительно выбран, а не просто набран
    cy.get(selector, { timeout: T.UI }).should('not.have.value', '');
    cy.wait(PAUSE.FIELD);
  };

  before(() => {
    expect(EMAIL, 'секрет CYPRESS_LOGIN_EMAIL не задан').to.be.a('string').and.not.be.empty;
    expect(PASSWORD, 'секрет CYPRESS_LOGIN_PASSWORD не задан').to.be.a('string').and.not.be.empty;
  });

  beforeEach(() => {
    // Значения по умолчанию: если прогон упадёт раньше, в отчёте останется
    // явный UNKNOWN / N/A, а не результат предыдущего запуска.
    cy.writeFile('auth_api_status.txt', 'UNKNOWN');
    cy.writeFile('api_status.txt', 'UNKNOWN');
    cy.writeFile('offers_count.txt', 'N/A');
  });

  it('Авторизация и поиск авиабилетов', () => {
    cy.viewport(1280, 800);

    // 1. ПЕРЕХВАТ API
    cy.intercept({ method: 'POST', url: '**/login**' }).as('apiAuth');

    // Поиск двухшаговый: POST заводит сессию поиска и возвращает её id,
    // а сами перелёты доливаются GET-опросами .../{id}/poll?count=100&cursor=…
    // Ошибку poll'а UI показывает как пустую выдачу, поэтому проверяем оба.
    cy.intercept({ method: 'POST', url: '**/api/v1/search/flights' }).as('apiSearch');
    cy.intercept({ method: 'GET', url: '**/api/v1/search/flights/*/poll**' }).as('apiPoll');

    // 2. ПЕРЕХОД НА ГЛАВНУЮ
    cy.visit('https://metatrip.asia/ru/', { timeout: T.PAGE });

    // 3. ОТКРЫТИЕ МОДАЛКИ "ВХОД В ПРОФИЛЬ"
    // Клик с повтором: страница на Nuxt приходит с сервера уже отрисованной,
    // и до окончания гидратации кнопка кликается вхолостую — модалка не встаёт.
    // На раннере GitHub Actions это ловилось стабильно, локально почти никогда.
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

    // 9. ОТКУДА
    pickAirport('input#search-from', ROUTE.FROM);

    // 10. КУДА
    pickAirport('input#search-to', ROUTE.TO);

    // 11. ОТКРЫТИЕ КАЛЕНДАРЯ "КОГДА"
    // Панель могла открыться сама после выбора города — тогда повторный клик
    // по полю её закроет, поэтому кликаем только если её нет в DOM.
    cy.get('body').then(($body) => {
      if ($body.find('.p-datepicker-panel').length === 0) {
        cy.contains('button', 'Когда', { timeout: T.UI }).should('be.visible').click({ timeout: T.UI });
      }
    });
    cy.get('.p-datepicker-panel', { timeout: T.UI }).should('be.visible');

    // 12. ГОД: заголовок календаря → year-view → 2028
    firstCalendar()
      .find('button.p-datepicker-select-year')
      .should('be.visible')
      .click({ timeout: T.UI });

    panel()
      .find('.p-datepicker-year-view span.p-datepicker-year')
      .not('.p-disabled')
      .contains(new RegExp(`^\\s*${DEPART.YEAR}\\s*$`))
      .click({ timeout: T.UI });

    // 13. МЕСЯЦ: month-view → Июн
    panel()
      .find('.p-datepicker-month-view span.p-datepicker-month')
      .not('.p-disabled')
      .contains(new RegExp(`^\\s*${DEPART.MONTH}\\s*$`))
      .click({ timeout: T.UI });

    // 14. ДЕНЬ: 24 июня 2028
    // aria-label на td содержит номер дня — не зависит от вложенности разметки.
    firstCalendar()
      .find(`td[aria-label="${DEPART.DAY}"] span.p-datepicker-day`)
      .not('.p-disabled')
      .first()
      .click({ timeout: T.UI });

    // Клик по дню прокрутил страницу к календарю, и форма ушла из вьюпорта.
    // Её обёртка data-reveal (анимация появления) в этот момент гасится в
    // opacity: 0 — Cypress считает поле даты и кнопку "Поиск" невидимыми.
    // Возвращаемся наверх и даём анимации проиграться обратно.
    cy.scrollTo('top');
    cy.wait(PAUSE.SUBMIT);

    // Дата встала в поле — иначе поиск уйдёт без даты
    cy.contains('button', new RegExp(`${DEPART.DAY}\\s+июня`), { timeout: T.UI }).should('be.visible');

    // 15. ПОИСК
    cy.contains('button', 'Поиск', { timeout: T.UI })
      .should('be.visible')
      .click({ timeout: T.UI });

    // 16. ПОИСК ДЕЙСТВИТЕЛЬНО УШЁЛ
    // Проверка обязательна: при незаполненных полях кнопка молча ничего не делает,
    // клик проходит без ошибки и тест выглядит зелёным. Маршрут и дата видны
    // в query-параметрах страницы результатов.
    cy.url({ timeout: T.PAGE })
      .should('include', '/flights')
      .and('include', `from=${ROUTE.FROM}`)
      .and('include', `to=${ROUTE.TO}`)
      .and('include', `dd=${DEPART.YEAR}-${DEPART.MONTH_NUM}-${DEPART.DAY}`);

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
    // Карточки доливаются по мере ответов poll'а, поэтому берём не первое
    // значение, а стабилизировавшееся — иначе в отчёт попадёт случайное число,
    // зависящее от скорости раннера.
    // Число пишем в файл до проверки: при пустой выдаче отчёт должен показать
    // "⚪ No Tickets" с нулём, а не "🔴 Unknown Test Failure" без числа.
    cy.countWhenStable(OFFER_CARD, { timeout: T.RESULTS, settle: PAUSE.SETTLE }).then((count) => {
      cy.writeFile('offers_count.txt', count.toString());
      cy.log(`✅ Найдено офферов: ${count}`);

      expect(count, 'офферов в выдаче').to.be.greaterThan(0);
    });
    cy.screenshot('after-search', { capture: 'viewport' });
  });
});
