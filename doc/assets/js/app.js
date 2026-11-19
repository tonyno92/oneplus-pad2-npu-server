
const menuToggle = document.getElementById("menuToggle");
const navigation = document.getElementById("navigation");

menuToggle.addEventListener("click", () => {
  const opened = navigation.classList.toggle("open");
  menuToggle.setAttribute("aria-expanded", opened);
});

navigation.querySelectorAll("a").forEach(link => {
  link.addEventListener("click", () => {
    navigation.classList.remove("open");
    menuToggle.setAttribute("aria-expanded", "false");
  });
});

// Evidenzia la sezione attualmente visualizzata
const sections = document.querySelectorAll("main section[id]");
const navLinks = document.querySelectorAll("nav a");

const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;

    navLinks.forEach(link => {
      link.classList.toggle(
        "active",
        link.getAttribute("href") === `#${entry.target.id}`
      );
    });
  });
}, {
  rootMargin: "-20% 0px -65% 0px"
});

sections.forEach(section => observer.observe(section));

// Ricerca glossario
const search = document.getElementById("glossarySearch");
const terms = document.querySelectorAll(".term");

search.addEventListener("input", () => {
  const query = search.value
    .toLowerCase()
    .trim();

  terms.forEach(term => {
    const content = term.textContent.toLowerCase();
    term.hidden = !content.includes(query);
  });
});
